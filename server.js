
import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import path from 'node:path';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const BASE = (
  process.env.NEXUS_BASE_URL ||
  'https://api.nexusapi.co/v1'
).replace(/\/$/, '');

const MODEL =
  process.env.VIDEO_MODEL ||
  'grok-imagine-video-1.5';

const KEY = process.env.NEXUS_API_KEY;
const SITE_PASSWORD = process.env.SITE_PASSWORD;

const jobs = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/png',
      'image/jpeg',
      'image/webp'
    ];

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error(
        'Chỉ hỗ trợ ảnh PNG, JPG hoặc WebP.'
      ));
    }

    cb(null, true);
  }
});

app.disable('x-powered-by');

app.use(express.json({
  limit: '20kb'
}));

// ======================================
// HIỂN THỊ GIAO DIỆN WEBSITE
// ======================================

// Hỗ trợ các file nằm trong thư mục public
app.use(express.static('public'));

// Hỗ trợ index.html nằm ở thư mục gốc GitHub
app.get('/', (req, res) => {
  res.sendFile(
    path.join(process.cwd(), 'index.html')
  );
});

// ======================================
// XÁC THỰC MẬT KHẨU WEBSITE
// ======================================

// Chỉ bảo vệ các API.
// Không chặn giao diện website.
app.use((req, res, next) => {

  if (
    !req.path.startsWith('/api/') ||
    req.path === '/api/health'
  ) {
    return next();
  }

  if (!SITE_PASSWORD) {
    return res.status(503).json({
      error:
        'SITE_PASSWORD chưa được thiết lập trên máy chủ.'
    });
  }

  const provided =
    req.get('x-site-password') || '';

  const a = Buffer.from(provided);
  const b = Buffer.from(SITE_PASSWORD);

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    return res.status(401).json({
      error: 'Mật khẩu website không đúng.'
    });
  }

  next();
});

// ======================================
// KIỂM TRA TRẠNG THÁI SERVER
// ======================================

app.get('/api/health', (req, res) => {
  res.json({
    ready: !!KEY && !!SITE_PASSWORD,
    model: MODEL
  });
});

// ======================================
// KẾT NỐI NEXUS API
// ======================================

async function upstream(apiPath, options = {}) {

  if (!KEY) {
    throw new Error(
      'Chưa cấu hình NEXUS_API_KEY'
    );
  }

  const response = await fetch(
    `${BASE}${apiPath}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${KEY}`,
        ...options.headers
      },
      signal: AbortSignal.timeout(90000)
    }
  );

  const responseText = await response.text();

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    data = {
      raw: responseText.slice(0, 500)
    };
  }

  if (!response.ok) {
    throw new Error(
      `Nexus HTTP ${response.status}: ${
        JSON.stringify(data).slice(0, 700)
      }`
    );
  }

  return data;
}

// ======================================
// TẠO VIDEO TỪ ẢNH
// ======================================

app.post(
  '/api/generate',
  upload.single('image'),
  async (req, res) => {

    try {

      if (!req.file) {
        return res.status(400).json({
          error:
            'Vui lòng chọn ảnh PNG/JPG/WebP tối đa 8 MB.'
        });
      }

      const prompt =
        (req.body.prompt || '').trim();

      if (
        !prompt ||
        prompt.length > 3000
      ) {
        return res.status(400).json({
          error:
            'Prompt phải có từ 1 đến 3000 ký tự.'
        });
      }

      const aspect_ratio =
        ['9:16', '16:9'].includes(
          req.body.aspect_ratio
        )
          ? req.body.aspect_ratio
          : '9:16';

      const imageData =
        `data:${req.file.mimetype};base64,` +
        req.file.buffer.toString('base64');

      const payload = {
        model: MODEL,
        prompt: prompt,
        duration: 10,
        resolution: '1080p',
        aspect_ratio: aspect_ratio,
        image: {
          url: imageData
        }
      };

      const data = await upstream(
        '/videos/generations',
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json'
          },
          body: JSON.stringify(payload)
        }
      );

      const id =
        data.request_id ||
        data.id;

      const direct =
        data.video?.url ||
        data.url;

      if (!id && !direct) {
        return res.status(502).json({
          error:
            'Nexus không trả về request_id hoặc URL video.',
          detail: data
        });
      }

      const localId =
        crypto.randomUUID();

      jobs.set(localId, {
        id,
        direct,
        created: Date.now()
      });

      res.json({
        job_id: localId,
        complete: !!direct
      });

    } catch (error) {

      res.status(502).json({
        error: error.message
      });

    }

  }
);

// ======================================
// KIỂM TRA TIẾN TRÌNH TẠO VIDEO
// ======================================

app.get(
  '/api/status/:id',
  async (req, res) => {

    try {

      const job =
        jobs.get(req.params.id);

      if (!job) {
        return res.status(404).json({
          error:
            'Không tìm thấy phiên tạo video. Máy chủ có thể đã khởi động lại.'
        });
      }

      if (
        Date.now() - job.created >
        3600000
      ) {
        jobs.delete(req.params.id);

        return res.status(410).json({
          error:
            'Phiên tạo video đã hết hạn.'
        });
      }

      if (job.direct) {
        return res.json({
          status: 'done',
          download_url:
            `/api/download/${req.params.id}`
        });
      }

      const data = await upstream(
        `/videos/${encodeURIComponent(job.id)}`
      );

      const url =
        data.video?.url ||
        data.url ||
        data.output?.url;

      const status =
        data.status ||
        (url ? 'done' : 'pending');

      if (url) {
        job.direct = url;
      }

      res.json({
        status,
        download_url: url
          ? `/api/download/${req.params.id}`
          : null,
        detail:
          status === 'failed'
            ? (
                data.error ||
                data.message ||
                'Video thất bại'
              )
            : undefined
      });

    } catch (error) {

      res.status(502).json({
        error: error.message
      });

    }

  }
);

// ======================================
// TẢI VIDEO MP4
// ======================================

app.get(
  '/api/download/:id',
  async (req, res) => {

    try {

      const job =
        jobs.get(req.params.id);

      if (!job?.direct) {
        return res.status(404).send(
          'Video chưa sẵn sàng'
        );
      }

      const videoUrl =
        new URL(job.direct);

      if (
        videoUrl.protocol !== 'https:'
      ) {
        return res.status(400).send(
          'Video URL không an toàn'
        );
      }

      const upstreamRes =
        await fetch(videoUrl, {
          signal:
            AbortSignal.timeout(120000)
        });

      if (
        !upstreamRes.ok ||
        !upstreamRes.body
      ) {
        throw new Error(
          'Không tải được video từ nhà cung cấp'
        );
      }

      res.setHeader(
        'Content-Type',
        'video/mp4'
      );

      res.setHeader(
        'Content-Disposition',
        'attachment; filename="grok-video.mp4"'
      );

      Readable
        .fromWeb(upstreamRes.body)
        .pipe(res);

    } catch (error) {

      if (!res.headersSent) {
        res.status(502).send(
          error.message
        );
      }

    }

  }
);

// ======================================
// XỬ LÝ LỖI UPLOAD
// ======================================

app.use((error, req, res, next) => {

  if (error) {
    return res.status(400).json({
      error: error.message
    });
  }

  next();
});

// ======================================
// KHỞI ĐỘNG WEBSITE
// ======================================

app.listen(PORT, () => {
  console.log(
    `Grok Imagine Studio listening on ${PORT}`
  );
});
