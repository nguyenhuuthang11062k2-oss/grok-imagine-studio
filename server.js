
import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const BASE = (
  process.env.NEXUS_BASE_URL ||
  'https://api.nexusapi.co/v1'
).replace(/\/+$/, '');

const MODEL =
  process.env.VIDEO_MODEL || 'grok-imagine-video-1.5';

const KEY = process.env.NEXUS_API_KEY;
const SITE_PASSWORD = process.env.SITE_PASSWORD;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const jobs = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

// ======================================================
// GHI LOG AN TOÀN - KHÔNG GHI API KEY, PASSWORD, PROMPT, ẢNH
// ======================================================

function logEvent(event, details = {}) {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      event,
      ...details
    })
  );
}

function logError(event, details = {}) {
  console.error(
    JSON.stringify({
      time: new Date().toISOString(),
      event,
      ...details
    })
  );
}

// ======================================================
// UPLOAD ẢNH
// ======================================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (
      ['image/jpeg', 'image/png', 'image/webp'].includes(
        file.mimetype
      )
    ) {
      cb(null, true);
    } else {
      cb(
        new Error(
          'Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.'
        )
      );
    }
  }
});

// ======================================================
// GIẢI THÍCH LỖI NEXUS
// ======================================================

function explainError(status, data) {
  const error = data?.error;

  const code =
    typeof error === 'object'
      ? error?.code
      : error;

  const message =
    typeof error === 'object'
      ? error?.message
      : data?.message;

  if (code === 'upstream_saturated') {
    return (
      'Nexus đang báo quá tải hoặc tài khoản upstream ' +
      'đạt giới hạn đồng thời. Hãy thử lại sau hoặc ' +
      'liên hệ nhà cung cấp.'
    );
  }

  if (status === 401) {
    return 'Nexus từ chối API Key. Kiểm tra lại key.';
  }

  if (status === 403) {
    return 'Tài khoản không có quyền truy cập tài nguyên này.';
  }

  if (status === 404) {
    return 'Endpoint hoặc model không tồn tại trên tuyến Nexus này.';
  }

  if (status === 429) {
    return 'Nexus giới hạn số lượng yêu cầu. Vui lòng chờ.';
  }

  if (status === 503) {
    return 'Dịch vụ Nexus hiện không sẵn sàng.';
  }

  if (status >= 500) {
    return 'Máy chủ Nexus gặp lỗi.';
  }

  return String(
    message || 'Nexus trả về lỗi không xác định.'
  ).slice(0, 300);
}

// ======================================================
// BẢO VỆ WEBSITE
// ======================================================

function safeEqual(a, b) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);

  return (
    aa.length === bb.length &&
    crypto.timingSafeEqual(aa, bb)
  );
}

// Cho phép tải giao diện để nhập mật khẩu
app.use(
  express.static(path.join(__dirname, 'public'))
);

app.get('/', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'index.html')
  );
});

// Bảo vệ các API bằng mật khẩu website
app.use('/api', (req, res, next) => {
  if (req.path === '/health') {
    return next();
  }

  if (!SITE_PASSWORD) {
    return res.status(503).json({
      error:
        'SITE_PASSWORD chưa được thiết lập trên Render.'
    });
  }

  const provided =
    req.get('x-site-password') || '';

  if (!safeEqual(provided, SITE_PASSWORD)) {
    return res.status(401).json({
      error: 'Mật khẩu website không đúng.'
    });
  }

  next();
});

// ======================================================
// KIỂM TRA TRẠNG THÁI WEBSITE
// ======================================================

app.get('/api/health', (req, res) => {
  res.json({
    ready: Boolean(KEY && SITE_PASSWORD),
    model: MODEL,
    configured: {
      apiKey: Boolean(KEY),
      password: Boolean(SITE_PASSWORD),
      baseUrl: Boolean(BASE)
    }
  });
});

// ======================================================
// GỌI API NEXUS VÀ GHI LOG CHI TIẾT
// ======================================================

async function upstream(
  endpoint,
  options = {},
  retries = 0
) {
  if (!KEY) {
    throw new Error(
      'Chưa cấu hình NEXUS_API_KEY trên Render.'
    );
  }

  const url = `${BASE}${endpoint}`;
  const method = options.method || 'GET';
  const maxAttempts = retries + 1;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    const startedAt = Date.now();

    logEvent('nexus_request', {
      endpoint,
      method,
      attempt,
      maxAttempts
    });

    let response;
    let data;

    try {
      response = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${KEY}`,
          ...options.headers
        },
        signal: AbortSignal.timeout(90000)
      });

      const raw = await response.text();

      try {
        data = JSON.parse(raw);
      } catch {
        data = {
          message: raw.slice(0, 500)
        };
      }
    } catch (err) {
      const elapsedSeconds = Number(
        ((Date.now() - startedAt) / 1000).toFixed(2)
      );

      logError('nexus_network_error', {
        endpoint,
        method,
        attempt,
        elapsedSeconds,
        errorType: err?.name || 'NetworkError'
      });

      if (attempt < maxAttempts) {
        const waitMs = 2000 * attempt;

        logEvent('nexus_retry', {
          endpoint,
          reason: 'network_error',
          nextAttempt: attempt + 1,
          waitMs
        });

        await sleep(waitMs);
        continue;
      }

      const error = new Error(
        'Không kết nối được Nexus hoặc yêu cầu đã hết thời gian chờ.'
      );

      error.status = 502;
      error.code = 'network_error';

      throw error;
    }

    const elapsedSeconds = Number(
      ((Date.now() - startedAt) / 1000).toFixed(2)
    );

    const code =
      typeof data?.error === 'object'
        ? data.error?.code
        : null;

    logEvent('nexus_response', {
      endpoint,
      method,
      attempt,
      httpStatus: response.status,
      elapsedSeconds,
      errorCode: code || null
    });

    if (response.ok) {
      return data;
    }

    const retryable =
      response.status === 429 ||
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504 ||
      code === 'upstream_saturated';

    if (retryable && attempt < maxAttempts) {
      const waitMs = 3000 * attempt;

      logEvent('nexus_retry', {
        endpoint,
        reason: code || `HTTP_${response.status}`,
        nextAttempt: attempt + 1,
        waitMs
      });

      await sleep(waitMs);
      continue;
    }

    const error = new Error(
      explainError(response.status, data)
    );

    error.status = response.status;
    error.code = code || null;

    throw error;
  }
}

// ======================================================
// KIỂM TRA KẾT NỐI NEXUS - KHÔNG TẠO VIDEO
// ======================================================

app.get('/api/check-nexus', async (req, res) => {
  try {
    const data = await upstream('/models');

    const models = Array.isArray(data?.data)
      ? data.data
          .map(item => item.id)
          .filter(Boolean)
      : Array.isArray(data?.models)
        ? data.models
            .map(item =>
              typeof item === 'string'
                ? item
                : item.id
            )
            .filter(Boolean)
        : [];

    res.json({
      connected: true,
      message:
        'Nexus phản hồi thành công tại /models.',
      configuredVideoModel: MODEL,
      models,
      videoModelListed: models.includes(MODEL),
      note:
        'Danh sách model không xác nhận endpoint tạo video hoạt động.'
    });
  } catch (err) {
    logError('nexus_check_failed', {
      httpStatus: err.status || 502,
      errorCode: err.code || null
    });

    res.status(err.status || 502).json({
      connected: false,
      error: err.message,
      code: err.code || null,
      note:
        'Lỗi /models không chứng minh toàn bộ Nexus API bị lỗi.'
    });
  }
});

// ======================================================
// TẠO VIDEO GROK IMAGINE
// ======================================================

app.post(
  '/api/generate',
  upload.single('image'),
  async (req, res) => {
    const requestTag = crypto.randomUUID().slice(0, 8);
    const startedAt = Date.now();

    try {
      if (!req.file) {
        return res.status(400).json({
          error:
            'Vui lòng tải lên ảnh JPG, PNG hoặc WebP tối đa 8 MB.'
        });
      }

      const prompt = String(
        req.body.prompt || ''
      ).trim();

      if (
        !prompt ||
        prompt.length > 10000
      ) {
        return res.status(400).json({
          error:
            'Prompt phải có từ 1 đến 10000 ký tự.'
        });
      }

      const aspect_ratio =
        ['9:16', '16:9'].includes(
          req.body.aspect_ratio
        )
          ? req.body.aspect_ratio
          : '9:16';

      // GIỮ NGUYÊN 1080P VÀ 10 GIÂY
      const payload = {
        model: MODEL,
        prompt,
        duration: 10,
        resolution: '1080p',
        aspect_ratio,
        image: {
          url:
            `data:${req.file.mimetype};base64,` +
            req.file.buffer.toString('base64')
        }
      };

      logEvent('video_generate_started', {
        requestTag,
        model: MODEL,
        duration: 10,
        resolution: '1080p',
        aspectRatio: aspect_ratio,
        imageType: req.file.mimetype
      });

      const data = await upstream(
        '/videos/generations',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        },
        2
      );

      const id =
        data.request_id ||
        data.id ||
        data.data?.request_id ||
        data.data?.id;

      const direct =
        data.video?.url ||
        data.url ||
        data.data?.video?.url;

      if (!id && !direct) {
        logError('video_invalid_response', {
          requestTag,
          reason:
            'missing_request_id_and_video_url'
        });

        return res.status(502).json({
          error:
            'Nexus phản hồi nhưng không có request_id hoặc URL video. Cần kiểm tra định dạng phản hồi API.'
        });
      }

      const localId = crypto.randomUUID();

      jobs.set(localId, {
        id,
        direct,
        created: Date.now()
      });

      logEvent('video_generate_accepted', {
        requestTag,
        hasRequestId: Boolean(id),
        hasDirectUrl: Boolean(direct),
        elapsedSeconds: Number(
          (
            (Date.now() - startedAt) /
            1000
          ).toFixed(2)
        )
      });

      res.json({
        job_id: localId,
        complete: Boolean(direct)
      });
    } catch (err) {
      logError('video_generate_failed', {
        requestTag,
        httpStatus: err.status || 502,
        errorCode: err.code || null,
        elapsedSeconds: Number(
          (
            (Date.now() - startedAt) /
            1000
          ).toFixed(2)
        )
      });

      res.status(err.status || 502).json({
        error: err.message,
        code: err.code || null
      });
    }
  }
);

// ======================================================
// KIỂM TRA TIẾN ĐỘ TẠO VIDEO
// ======================================================

app.get('/api/status/:id', async (req, res) => {
  try {
    const job = jobs.get(req.params.id);

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
      data.output?.url ||
      data.data?.video?.url;

    const rawStatus = String(
      data.status ||
      data.data?.status ||
      ''
    ).toLowerCase();

    const status = url
      ? 'done'
      : ['failed', 'error', 'cancelled'].includes(
          rawStatus
        )
        ? 'failed'
        : 'pending';

    if (url) {
      job.direct = url;
    }

    if (status === 'done') {
      logEvent('video_completed', {
        hasVideoUrl: true
      });
    }

    if (status === 'failed') {
      logError('video_processing_failed', {
        status: rawStatus
      });
    }

    res.json({
      status,
      download_url: url
        ? `/api/download/${req.params.id}`
        : null,
      detail:
        status === 'failed'
          ? (
              data.error?.message ||
              data.message ||
              'Tạo video thất bại.'
            )
          : undefined
    });
  } catch (err) {
    logError('video_status_failed', {
      httpStatus: err.status || 502,
      errorCode: err.code || null
    });

    res.status(err.status || 502).json({
      error: err.message
    });
  }
});

// ======================================================
// TẢI VIDEO VỀ MÁY
// ======================================================

app.get('/api/download/:id', async (req, res) => {
  try {
    const job = jobs.get(req.params.id);

    if (!job?.direct) {
      return res.status(404).send(
        'Video chưa sẵn sàng.'
      );
    }

    const url = new URL(job.direct);

    if (url.protocol !== 'https:') {
      return res.status(400).send(
        'URL video không an toàn.'
      );
    }

    const allowedHosts = (
      process.env.VIDEO_DOWNLOAD_HOSTS || ''
    )
      .split(',')
      .map(host =>
        host.trim().toLowerCase()
      )
      .filter(Boolean);

    if (
      !allowedHosts.includes(
        url.hostname.toLowerCase()
      )
    ) {
      return res.status(403).send(
        'Host video chưa được cho phép. Cần cấu hình VIDEO_DOWNLOAD_HOSTS.'
      );
    }

    const upstreamRes = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(120000)
    });

    if (
      !upstreamRes.ok ||
      !upstreamRes.body
    ) {
      throw new Error(
        'Không tải được video từ nhà cung cấp.'
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

    Readable.fromWeb(
      upstreamRes.body
    ).pipe(res);
  } catch (err) {
    logError('video_download_failed', {
      errorType: err?.name || 'DownloadError'
    });

    if (!res.headersSent) {
      res.status(502).send(err.message);
    }
  }
});

// ======================================================
// XỬ LÝ LỖI UPLOAD VÀ LỖI KHÁC
// ======================================================

app.use((err, req, res, next) => {
  logError('application_error', {
    errorType: err?.name || 'ApplicationError'
  });

  res.status(400).json({
    error:
      err.message ||
      'Dữ liệu gửi lên không hợp lệ.'
  });
});

// ======================================================
// KHỞI ĐỘNG SERVER
// ======================================================

app.listen(PORT, () => {
  logEvent('server_started', {
    port: PORT,
    model: MODEL,
    duration: 10,
    resolution: '1080p',
    apiKeyConfigured: Boolean(KEY),
    passwordConfigured: Boolean(SITE_PASSWORD)
  });

  console.log(
    `Grok Imagine Studio listening on ${PORT}`
  );
});
