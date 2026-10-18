const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');
const vmService = require('./vmService');

/**
 * Reads all current boot log content (serial boot.log + qemu.log) for a VM.
 */
function getBootLogs(vm) {
  return vmService.getBootLog(vm);
}

/**
 * Clears boot and QEMU logs for a given VM.
 */
function clearBootLogs(vm) {
  const dir = path.join(vmService.VM_DIR, String(vm.id));
  const bootLog = path.join(dir, 'boot.log');
  const qemuLog = path.join(dir, 'qemu.log');
  try {
    if (fs.existsSync(bootLog)) fs.writeFileSync(bootLog, '', 'utf8');
    if (fs.existsSync(qemuLog)) fs.writeFileSync(qemuLog, '', 'utf8');
    return true;
  } catch (e) {
    logger.warn(`[bootlog] Failed to clear logs for VM ${vm.id}: ${e.message}`);
    return false;
  }
}

/**
 * Creates an active streaming tail for a VM's boot and QEMU log files.
 * @param {object} vm - The VM object.
 * @param {object} options - Callbacks { onData, onError, onClose, pollInterval }
 * @returns {object} Controller with close() method.
 */
function createBootLogStream(vm, { onData, onError, onClose, pollInterval = 300 } = {}) {
  const dir = path.join(vmService.VM_DIR, String(vm.id));
  const bootLogPath = path.join(dir, 'boot.log');
  const qemuLogPath = path.join(dir, 'qemu.log');

  let closed = false;
  let bootOffset = 0;
  let qemuOffset = 0;
  let timer = null;
  let bootWatcher = null;
  let qemuWatcher = null;
  let readingBoot = false;
  let readingQemu = false;

  // Send initial snapshot
  try {
    const initialText = getBootLogs(vm);
    if (fs.existsSync(bootLogPath)) {
      bootOffset = fs.statSync(bootLogPath).size;
    }
    if (fs.existsSync(qemuLogPath)) {
      qemuOffset = fs.statSync(qemuLogPath).size;
    }
    if (onData) {
      onData(initialText, { init: true });
    }
  } catch (e) {
    if (onError) onError(e);
  }

  function readNewBytes(filePath, currentOffset, onChunk, onDone) {
    if (closed || !fs.existsSync(filePath)) {
      onDone(currentOffset);
      return;
    }
    fs.stat(filePath, (err, stats) => {
      if (err || closed) {
        onDone(currentOffset);
        return;
      }
      const newSize = stats.size;
      if (newSize < currentOffset) {
        // File was truncated / cleared
        currentOffset = 0;
      }
      if (newSize === currentOffset) {
        onDone(currentOffset);
        return;
      }

      const stream = fs.createReadStream(filePath, {
        start: currentOffset,
        end: newSize - 1,
        encoding: 'utf8',
      });

      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
      });

      stream.on('end', () => {
        if (buf && onChunk && !closed) {
          onChunk(buf);
        }
        onDone(newSize);
      });

      stream.on('error', (err) => {
        logger.warn(`[bootlog] Read stream error on ${filePath}: ${err.message}`);
        onDone(currentOffset);
      });
    });
  }

  function checkUpdates() {
    if (closed) return;

    if (!readingBoot) {
      readingBoot = true;
      readNewBytes(bootLogPath, bootOffset, (chunk) => {
        if (onData) onData(chunk, { init: false, source: 'boot' });
      }, (nextOffset) => {
        bootOffset = nextOffset;
        readingBoot = false;
      });
    }

    if (!readingQemu) {
      readingQemu = true;
      readNewBytes(qemuLogPath, qemuOffset, (chunk) => {
        if (onData) onData(`\n[QEMU] ${chunk}`, { init: false, source: 'qemu' });
      }, (nextOffset) => {
        qemuOffset = nextOffset;
        readingQemu = false;
      });
    }
  }

  // Setup fs.watch where possible for low-latency notifications
  try {
    if (fs.existsSync(bootLogPath)) {
      bootWatcher = fs.watch(bootLogPath, () => checkUpdates());
    }
  } catch (_) {}

  try {
    if (fs.existsSync(qemuLogPath)) {
      qemuWatcher = fs.watch(qemuLogPath, () => checkUpdates());
    }
  } catch (_) {}

  // Periodic timer guarantees catch-up even if fs.watch misses events or file is newly created
  timer = setInterval(checkUpdates, pollInterval);

  function close() {
    if (closed) return;
    closed = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (bootWatcher) {
      try { bootWatcher.close(); } catch (_) {}
      bootWatcher = null;
    }
    if (qemuWatcher) {
      try { qemuWatcher.close(); } catch (_) {}
      qemuWatcher = null;
    }
    if (onClose) onClose();
  }

  return { close, checkUpdates };
}

/**
 * Handle Server-Sent Events (SSE) HTTP endpoint for streaming boot logs.
 */
function handleSseStream(req, res, vm) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const sendEvent = (event, payload) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  sendEvent('status', { status: vmService.statusOf(vm), vmId: vm.id, vmName: vm.name });

  const stream = createBootLogStream(vm, {
    onData: (text, meta) => {
      sendEvent('log', { text, init: !!meta.init, source: meta.source || 'boot' });
    },
    onError: (err) => {
      sendEvent('error', { message: err.message });
    },
    onClose: () => {
      sendEvent('close', {});
    },
  });

  // Heartbeat every 15s to keep connection alive through proxies
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    stream.close();
  });
}

module.exports = {
  getBootLogs,
  clearBootLogs,
  createBootLogStream,
  handleSseStream,
};
