const express = require('express');
const license = require('../lib/license');
const router = express.Router();

// Weekly-license entry page. Reached automatically when the license expires.
router.get('/license', (req, res) => {
  const st = license.status();
  res.render('auth/license', {
    title: 'License',
    settings: res.locals.settings || {},
    user: req.user || null,
    locked: st.locked,
    daysLeft: st.daysLeft,
    expiresAt: st.expiresAt,
  });
});

module.exports = router;