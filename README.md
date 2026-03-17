# RTSP Direct Bridge

This is a Node.js bridging application that establishes a stable, low-latency two-way audio connection between an Asterisk server (via AudioSocket) and a Reolink Doorbell (via direct RTSP and RTP).

## How It Works
- Listens for Asterisk AudioSocket connections on port 8080.
- On connection, performs an on-demand RTSP handshake with your Reolink Doorbell.
- Receives raw AAC audio from the Doorbell, adds ADTS headers, and uses FFmpeg to transcode to raw PCM for Asterisk.
- Receives Asterisk PCM audio, uses FFmpeg to transcode to PCMU (G.711u), and sends it to the Doorbell via synchronized RTP matching the camera's base timestamp.
- Maintains keep-alives and session recovery on disconnects/errors.

## TrueNAS SCALE Deployment

Since TrueNAS SCALE supports Custom Docker Apps, you can run this bridge as a container. 

### Option 1: Build & Push via a remote machine (Recommended)
1. Copy this entire folder (`audiosocket-reolink-node`) to a machine with Docker installed.
2. Build the image:
   - For Docker Hub: `docker build -t your-username/rtsp-bridge:latest .`
   - For GitHub Registry: `docker build -t ghcr.io/your-username/rtsp-bridge:latest .`
3. Push the image to your registry:
   - For Docker Hub: `docker push your-username/rtsp-bridge:latest`
   - For GitHub Registry (Requires `docker login ghcr.io` with a PAT): `docker push ghcr.io/your-username/rtsp-bridge:latest`
4. On TrueNAS SCALE, go to **Apps** -> **Discover Apps** -> **Custom App**.
5. Set the **Image Repository** to `your-username/rtsp-bridge` (or `ghcr.io/your-username/rtsp-bridge`) and **Image Tag** to `latest`.
   *(Note: If your registry is private, you will need to add Private Registry Credentials in TrueNAS first under Apps -> Settings -> Advanced Settings -> Pull Secret).*
6. Add the following **Environment Variables**:
   - `REOLINK_IP`: The IP address of your Reolink Doorbell (e.g. `192.168.16.220`)
   - `REOLINK_USER`: The username for the camera (Default: `admin`)
   - `REOLINK_PASS`: The password for the camera
   - `REOLINK_PORT`: (Optional) The RTSP port (Default: `554`)
   - `RTSP_PATH`: (Optional) The specific RTSP sub-path (Default: `/h264Preview_01_sub`)
   - `LISTEN_PORT`: (Optional) The port for Asterisk to reach the bridge (Default: `8080`)
   - `RTP_PORT`: (Optional) The starting UDP port for receiving media (Default: `50000`)
   - `BACKCHANNEL_GAIN`: (Optional) The gain applied to speaker audio (Default: `1.5`)
7. **Networking**: Under Port Forwarding, forward the Node Port to Container Port `8080` (TCP). Importantly, you must also forward UDP ports `50000` to `50005` on the Host Network to the Container to allow incoming Doorbell audio to work properly.
8. Save and deploy.

### Option 2: Build directly on TrueNAS SCALE shell (If developer mode is enabled)
1. SSH into your TrueNAS SCALE box.
2. Transfer this folder to your dataset.
3. Build the image locally in the k3s/docker environment depending on your TrueNAS SCALE version.
4. Deploy a Custom App using your locally built image name.
