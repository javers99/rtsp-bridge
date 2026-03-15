# Base image with Node.js
FROM node:18-alpine

# Install ffmpeg
RUN apk add --no-cache ffmpeg

# Create app directory
WORKDIR /usr/src/app

# Copy package files and install dependencies (if any)
# Note: Currently no external packages are used, but good practice
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Expose the AudioSocket port
EXPOSE 8080

# Run the bridge
CMD [ "node", "rtsp-direct.js" ]
