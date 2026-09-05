const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

function makeUploader(subdir, { allowed, maxSize = 30 * 1024 * 1024 }) {
  const dir = path.resolve(__dirname, '../../public/uploads', subdir);
  fs.mkdirSync(dir, { recursive: true });
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${ext}`);
    },
  });
  const upload = multer({
    storage,
    limits: { fileSize: maxSize },
    fileFilter: (_req, file, cb) => {
      if (allowed.includes('*')) return cb(null, true);
      const ext = path.extname(file.originalname).toLowerCase();
      if (allowed.includes(ext)) return cb(null, true);
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
