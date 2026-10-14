# Grok Imagine Video Studio — Nexus API

## Deploy on Render (Node web service)
1. Create a **private** GitHub repository and upload these files (do not upload any `.env` file).
2. In Render, select **New > Web Service** and connect your repository.
3. Set build command `npm install` and start command `npm start`.
4. Add environment variables:
   - `NEXUS_API_KEY`: your real key (only in Render settings).
   - `SITE_PASSWORD`: a strong password for access from your two computers.
   - `NEXUS_BASE_URL`: `https://api.nexusapi.co/v1`.
   - `VIDEO_MODEL`: `grok-imagine-video-1.5` (only if Nexus supports it).
5. Deploy and open the HTTPS URL provided by Render.
6. Enter the website password, upload a photo, type your prompt, and click Generate Video.

## Important limitations
- The Nexus provider's video API compatibility is **not confirmed**. The application assumes an xAI-like `POST /videos/generations`, `GET /videos/{request_id}` API and image data URI support. An unsupported endpoint/model will return an error.
- This is a proof of concept. In-memory jobs are lost on restart. For production use, add durable job storage, user accounts, rate limiting, upload scanning, quotas, and controlled video URL proxying.
- The website password is passed over HTTPS to the server for each request; do not deploy without HTTPS. Use a private GitHub repo and never put your key in source code or browser JavaScript.
- The video API may charge per second separately from the 300M text token quota. Ask the seller before generating large batches.
