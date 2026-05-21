const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const router = express.Router();

// ─── Config ───────────────────────────────────────────────────────────────────

const storageConfig = {
  adapter: process.env.STORAGE_ADAPTER || 'local',
  local: {
    uploadDir: process.env.STORAGE_UPLOAD_DIR || path.join(__dirname, 'uploads', 'storage'),
    baseUrl: process.env.STORAGE_BASE_URL || 'http://localhost:8001/storage/files',
  },
  minio: {
    endpoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT || '9000', 10),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
    bucket: process.env.MINIO_BUCKET || 'connectdoctor',
    publicUrl: process.env.MINIO_PUBLIC_URL || 'http://localhost:9000',
  },
};

// ─── Local Adapter ────────────────────────────────────────────────────────────

class LocalAdapter {
  constructor() {
    fs.mkdirSync(storageConfig.local.uploadDir, { recursive: true });
  }

  async upload(key, buffer, mimeType) {
    const absPath = path.join(storageConfig.local.uploadDir, key);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, buffer);
    return { url: `${storageConfig.local.baseUrl}/${key}`, key };
  }

  async delete(key) {
    const absPath = path.join(storageConfig.local.uploadDir, key);
    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
  }
}

// ─── MinIO Adapter ────────────────────────────────────────────────────────────

class MinioAdapter {
  constructor() {
    const Minio = require('minio');
    this.client = new Minio.Client({
      endPoint: storageConfig.minio.endpoint,
      port: storageConfig.minio.port,
      useSSL: storageConfig.minio.useSSL,
      accessKey: storageConfig.minio.accessKey,
      secretKey: storageConfig.minio.secretKey,
    });
    this.bucket = storageConfig.minio.bucket;
  }

  async _ensureBucket() {
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) {
      await this.client.makeBucket(this.bucket);
      await this.client.setBucketPolicy(this.bucket, JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${this.bucket}/*`],
        }],
      }));
    }
  }

  async upload(key, buffer, mimeType) {
    await this._ensureBucket();
    await this.client.putObject(this.bucket, key, buffer, buffer.length, { 'Content-Type': mimeType });
    return { url: `${storageConfig.minio.publicUrl}/${this.bucket}/${key}`, key };
  }

  async delete(key) {
    await this.client.removeObject(this.bucket, key);
  }
}

// ─── Pick adapter ─────────────────────────────────────────────────────────────

let adapter;
if (storageConfig.adapter === 'minio') {
  adapter = new MinioAdapter();
} else {
  adapter = new LocalAdapter();
}

// ─── Serve local files ────────────────────────────────────────────────────────

if (storageConfig.adapter === 'local') {
  router.use('/files', express.static(storageConfig.local.uploadDir));
}

// ─── Routes ───────────────────────────────────────────────────────────────────

const upload = multer({ storage: multer.memoryStorage() });

// POST /storage/upload  — multipart: file (binary) + key (string, optional)
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided' });
  }
  const key = req.body.key || `uploads/${Date.now()}-${req.file.originalname}`;
  try {
    const result = await adapter.upload(key, req.file.buffer, req.file.mimetype);
    res.json(result);
  } catch (err) {
    console.error('[STORAGE] Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// DELETE /storage/files  — body: { key: string }
router.delete('/files', async (req, res) => {
  const { key } = req.body;
  if (!key) {
    return res.status(400).json({ error: 'key is required' });
  }
  try {
    await adapter.delete(key);
    res.json({ success: true });
  } catch (err) {
    console.error('[STORAGE] Delete error:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// GET /storage/health
router.get('/health', (_req, res) => {
  res.json({ adapter: storageConfig.adapter, ok: true });
});

module.exports = router;
