'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { scanImage, InvalidImageError } = require('./scanner');

const app = express();

// Store uploads in memory — never touch disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

app.use(express.static('public'));

app.post('/scan', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No image provided' });
  }

  try {
    const TIMEOUT_MS = 40000;
    const timeout = new Promise(resolve => setTimeout(() => resolve([]), TIMEOUT_MS));
    const results = await Promise.race([scanImage(req.file.buffer), timeout]);
    return res.status(200).json({
      success: true,
      count: results.length,
      results,
    });
  } catch (err) {
    if (err instanceof InvalidImageError) {
      return res.status(422).json({ success: false, error: 'Failed to process image' });
    }
    console.error('Scan error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Handle Multer errors (e.g. file too large)
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, error: 'File too large. Maximum size is 10MB.' });
  }
  console.error('Unexpected error:', err);
  return res.status(500).json({ success: false, error: 'Internal server error' });
});

// Only start listening when this file is run directly (not during tests)
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const certDir = path.join(__dirname, '..');
  const certFile = path.join(certDir, '192.168.10.211.pem');
  const keyFile  = path.join(certDir, '192.168.10.211-key.pem');

  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const sslOptions = {
      cert: fs.readFileSync(certFile),
      key:  fs.readFileSync(keyFile),
    };
    https.createServer(sslOptions, app).listen(PORT, () => {
      console.log(`ZXing scan API running on https://192.168.10.211:${PORT}`);
      console.log('POST /scan  — form-data field: "image"');
    });
  } else {
    app.listen(PORT, () => {
      console.log(`ZXing scan API running on http://localhost:${PORT}`);
      console.log('POST /scan  — form-data field: "image"');
    });
  }
}

module.exports = { app };
