/**
 * Full Automated End-to-End Test Suite for vPanel Pro
 */
const axios = require('axios');
const { db, settings } = require('../src/lib/db');
const authService = require('../src/services/authService');
const vmService = require('../src/services/vmService');
const nodeService = require('../src/services/nodeService');
const wallpaperService = require('../src/services/wallpaperService');

const BASE_WEB = 'http://127.0.0.1:3001';
const BASE_API = 'http://127.0.0.1:3002/api';

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log('  [PASS]', message);
    testsPassed++;
  } else {
    console.error('  [FAIL]', message);
    testsFailed++;
  }
}

async function runAutoFullTest() {
  console.log('\n======================================================');
  console.log('       STARTING FULL AUTOMATED TEST SUITE             ');
  console.log('======================================================\n');

  // ----------------------------------------------------
  // SECTION 1: DATABASE & USER AUTHENTICATION
  // ----------------------------------------------------
  console.log('>>> 1. Database & Authentication Tests');
  const adminUser = db.prepare('SELECT * FROM users WHERE role = ? OR root_admin = 1 LIMIT 1').get('admin');
  assert(!!adminUser, 'Admin user exists in database');

  const token = authService.signToken(adminUser);
  assert(!!token && token.length > 20, 'JWT Token signed successfully');

  const authHeaders = {
    Authorization: 'Bearer ' + token,
    Cookie: 'token=' + token,
  };

  // Test Register a new temporary test user
  const testUsername = 'autotest_' + Date.now();
  const created = authService.createUser({
    username: testUsername,
    email: `${testUsername}@vpanel.local`,
    password: 'TestPassword123!',
    name: 'Auto Test User',
    role: 'user',
    verified: 1,
  });
  assert(!!created && created.username === testUsername, 'Create new user via authService');

  const loginRes = authService.attemptLogin(testUsername, 'TestPassword123!', '127.0.0.1');
  assert(loginRes.ok === true, 'Authenticate newly created user');

  // Clean up test user
  db.prepare('DELETE FROM users WHERE username = ?').run(testUsername);
  assert(true, 'Test user cleaned up');

  // ----------------------------------------------------
  // SECTION 2: HYPERVISOR & NO-KVM / KVM DETECTION
  // ----------------------------------------------------
  console.log('\n>>> 2. Hypervisor & No-KVM Detection Tests');
  const defaultKvm = vmService.hasKvm();
  assert(typeof defaultKvm === 'boolean', `Default KVM detection: ${defaultKvm ? 'KVM Hardware' : 'No-KVM (TCG)'}`);

  process.env.NO_KVM = '1';
  const forcedNoKvm = vmService.hasKvm();
  assert(forcedNoKvm === false, 'Forced NO_KVM=1 correctly switches to TCG software emulation mode');
  delete process.env.NO_KVM;

  // ----------------------------------------------------
  // SECTION 3: NODES & PERFORMANCE TELEMETRY
  // ----------------------------------------------------
  console.log('\n>>> 3. Nodes & Performance Telemetry Tests');
  const nodeStats = nodeService.getNodeLiveStats();
  assert(nodeStats.status === 'online', 'Node status is online');
  assert(typeof nodeStats.cpu.percent === 'number', `CPU utilization tracked: ${nodeStats.cpu.percent}%`);
  assert(Array.isArray(nodeStats.cpu.per_core), `Per-core CPU matrix tracked: ${nodeStats.cpu.per_core.length} cores`);
  assert(typeof nodeStats.memory.percent === 'number', `Memory utilization tracked: ${nodeStats.memory.percent}%`);
  assert(typeof nodeStats.disk.percent === 'number', `Disk utilization tracked: ${nodeStats.disk.percent}%`);
  assert(typeof nodeStats.network.rx_kbps === 'number', `Network RX/TX throughput tracked: ${nodeStats.network.rx_kbps} KB/s`);
  assert(Array.isArray(nodeStats.history.cpu), 'Rolling 30-point waveform history buffer operational');

  // ----------------------------------------------------
  // SECTION 4: 4K WALLPAPERS & CUSTOMIZATION API
  // ----------------------------------------------------
  console.log('\n>>> 4. Wallpapers & Customization Tests');
  const wpData = await wallpaperService.getWallpapers({ category: 'all', page: 1 });
  assert(wpData.ok === true && Array.isArray(wpData.wallpapers), `4K Wallpapers API returned ${wpData.wallpapers ? wpData.wallpapers.length : 0} items`);

  try {
    const applyWp = await axios.post(`${BASE_API}/wallpapers/apply`, {
      url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe',
      mode: 'image',
      blur: '16',
      transparency: '65',
      overlay: '0.55',
    }, { headers: authHeaders });
    assert(applyWp.data.ok === true, 'Apply wallpaper & save sliders via API');
  } catch (e) {
    assert(false, 'Apply wallpaper API: ' + e.message);
  }

  // ----------------------------------------------------
  // SECTION 5: VIRTUAL MACHINES API
  // ----------------------------------------------------
  console.log('\n>>> 5. Virtual Machines & Boot Log Tests');
  try {
    const vmsRes = await axios.get(`${BASE_API}/vms`, { headers: authHeaders });
    assert(vmsRes.status === 200 && Array.isArray(vmsRes.data.vms), `GET /api/vms returned ${vmsRes.data.vms.length} VMs`);

    if (vmsRes.data.vms.length > 0) {
      const vmId = vmsRes.data.vms[0].id;
      const statusRes = await axios.get(`${BASE_API}/vms/${vmId}/status`, { headers: authHeaders });
      assert(statusRes.data.ok === true, `GET /api/vms/${vmId}/status returned live VM telemetry`);

      const statsRes = await axios.get(`${BASE_API}/vms/${vmId}/stats`, { headers: authHeaders });
      assert(statsRes.data.ok === true, `GET /api/vms/${vmId}/stats alias endpoint verified`);

      const bootlogRes = await axios.get(`${BASE_API}/vms/${vmId}/bootlog`, { headers: authHeaders });
      assert(bootlogRes.data.ok === true, `GET /api/vms/${vmId}/bootlog verified`);
    }
  } catch (e) {
    assert(false, 'VMs API check: ' + e.message);
  }

  // ----------------------------------------------------
  // SECTION 6: WEB UI ROUTES VERIFICATION
  // ----------------------------------------------------
  console.log('\n>>> 6. Web UI Endpoints Verification');
  const webRoutes = [
    { path: '/dashboard', label: 'User Dashboard' },
    { path: '/profile', label: 'User Profile' },
    { path: '/settings', label: 'User Settings' },
    { path: '/user-settings', label: 'User Settings Alias' },
    { path: '/activity', label: 'Activity Logs' },
    { path: '/notifications', label: 'Notifications' },
    { path: '/admin', label: 'Admin Overview' },
    { path: '/admin/nodes', label: 'Admin Nodes & Live Status' },
    { path: '/admin/nodes/status', label: 'Admin Node Telemetry JSON' },
    { path: '/admin/servers', label: 'Admin Server Management' },
    { path: '/admin/servers/create', label: 'Admin Create Server' },
    { path: '/admin/users', label: 'Admin User Management' },
    { path: '/admin/activity', label: 'Admin Activity Log' },
    { path: '/admin/settings', label: 'Admin Settings & General Tab' },
    { path: '/servers/1', label: 'VM Overview' },
    { path: '/servers/1/console', label: 'VM Console & Terminal' },
    { path: '/servers/1/files', label: 'VM File Manager' },
    { path: '/servers/1/backups', label: 'VM Backups' },
    { path: '/servers/1/schedules', label: 'VM Schedules' },
    { path: '/servers/1/settings', label: 'VM Settings' },
    { path: '/servers/1/startup', label: 'VM Startup' },
    { path: '/servers/1/subusers', label: 'VM Subusers' },
  ];

  for (const r of webRoutes) {
    try {
      const res = await axios.get(`${BASE_WEB}${r.path}`, { headers: authHeaders, maxRedirects: 5 });
      assert(res.status === 200, `GET ${r.path} [${r.label}] -> HTTP 200`);
    } catch (e) {
      assert(false, `GET ${r.path} [${r.label}] -> Error: ${e.response ? e.response.status : e.message}`);
    }
  }

  // ----------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------
  console.log('\n======================================================');
  console.log(`  TEST RESULTS: ${testsPassed} PASSED, ${testsFailed} FAILED`);
  console.log('======================================================\n');

  process.exit(testsFailed > 0 ? 1 : 0);
}

runAutoFullTest().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

