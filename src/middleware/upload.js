const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Stored filenames are served statically, so an "extension" may never carry
// separators, control characters or markup - only a plain short extension is
// accepted (rejects crafted names like `a.png\..\x` before they reach disk).
const SAFE_EXT = /^\.[a-z0-9]{1,8}$/;
function safeExt(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return SAFE_EXT.test(ext) ? ext : '';
}

function makeUploader(subdir, { allowed, maxSize = 30 * 1024 * 1024 }) {
  const dir = path.resolve(__dirname, '../../public/uploads', subdir);
  fs.mkdirSync(dir, { recursive: true });
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dir),
    filename: (_req, file, cb) => {
      cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${safeExt(file.originalname)}`);
    },
  });
  const upload = multer({
    storage,
    limits: { fileSize: maxSize },
    fileFilter: (_req, file, cb) => {
      const ext = safeExt(file.originalname);
      if (ext && (allowed.includes('*') || allowed.includes(ext))) return cb(null, true);
      cb(new Error(`File type not allowed: ${file.originalname}`));
    },
  });
  return upload;
}

const uploadLogo = makeUploader('logo', { allowed: ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif'] });
const uploadFavicon = makeUploader('favicon', { allowed: ['.png', '.ico', '.jpg', '.jpeg', '.svg', '.webp', '.gif'] });
const uploadBackground = makeUploader('background', { allowed: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.avi', '.mov'] });
const uploadMusic = makeUploader('music', { allowed: ['.mp3', '.ogg', '.wav', '.m4a', '.aac', '.flac', '.mp4', '.webm'] });
const uploadAvatar = makeUploader('avatar', { allowed: ['.png', '.jpg', '.jpeg', '.webp', '.gif'] });

module.exports = { uploadLogo, uploadFavicon, uploadBackground, uploadMusic, uploadAvatar };
