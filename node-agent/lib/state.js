'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'node-state.json');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let state = null;

function defaultState() {
  return {
    nodeId: 1,
    name: 'Primary Node',
    location: 'Primary Datacenter',
    joinCode: '',
    vms: [],                       // [{ id, uuid, name, os_type, os_name, img_url, hostname, username, password, disk_size, memory, cpus, ssh_port, vnc_port, agent_port, agent_token, port_forwards, gui_mode, start_on_boot, startup_command, notes, img_file, seed_file, created_at, updated_at }]
    nextVmId: 1,
    used_ports: [],                // allocated host ports
    os_list: [],
  };
}

function load() {
  ensureDirs();
  if (state) return state;
  if (fs.existsSync(STATE_FILE)) {
    try {
      state = Object.assign(defaultState(), JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
    } catch (e) {
      state = defaultState();
    }
  } else {
    state = defaultState();
  }
  return state;
}

function save() {
  ensureDirs();
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

function get() {
  return load();
}

function setNodeMeta(meta) {
  const s = get();
  if (meta.name !== undefined) s.name = meta.name;
  if (meta.location !== undefined) s.location = meta.location;
  save();
  return s;
}

function getVm(id) {
  return get().vms.find((v) => String(v.id) === String(id) || String(v.uuid) === String(id)) || null;
}

function getVmByUuid(uuid) {
  return get().vms.find((v) => v.uuid === uuid) || null;
}

function upsertVm(vm) {
  const s = get();
  const idx = s.vms.findIndex((v) => String(v.id) === String(vm.id));
  if (idx >= 0) s.vms[idx] = vm;
  else s.vms.push(vm);
  save();
}

function removeVm(id) {
  const s = get();
  const idx = s.vms.findIndex((v) => String(v.id) === String(id));
  if (idx >= 0) s.vms.splice(idx, 1);
  save();
}

function allVms() {
  return get().vms.slice();
}

function setOsList(list) {
  get().os_list = Array.isArray(list) ? list : [];
  save();
}

function osList() {
  return get().os_list;
}

function setJoinCode(code) {
  get().joinCode = String(code || '');
  save();
}

function joinCode() {
  return get().joinCode;
}

function nextId() {
  const s = get();
  const id = s.nextVmId++;
  save();
  return id;
}

module.exports = {
  ensureDirs,
  get,
  getVm,
  getVmByUuid,
  upsertVm,
  removeVm,
  allVms,
  setOsList,
  osList,
  setNodeMeta,
  setJoinCode,
  joinCode,
  nextId,
  STATE_FILE,
};
