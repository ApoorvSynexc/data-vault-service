FROM node:24-slim
 
# Set the working directory in the container
WORKDIR /app
 
# Copy package.json and package-lock.json to the container
COPY package*.json ./
 
# Install dependencies
RUN npm i
 
# Copy the rest of the application code to the container
COPY . .
 
# Build the application
RUN npm run build
 
# Writable log directory (logger uses LOG_DIR; default below)
ENV LOG_DIR=/app/logs
RUN mkdir -p /app/logs \
&& chown -R node:node /app
 
# Expose the port the app will run on
EXPOSE 3005
 
# Run as non-root; /app is owned by node so logs and runtime writes succeed
USER node
 
# Start the application
CMD ["npm", "start"]