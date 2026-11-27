# Step 1: Base Image (Lightweight Alpine Linux)
FROM node:20-alpine

# Step 2: Set the working directory inside the container
WORKDIR /app

# Step 3: Copy package.json and package-lock.json first (for layer caching)
COPY package*.json ./

# Step 4: Install dependencies (production only to save space)
RUN npm install --production

# Step 5: Copy the rest of the application files
COPY . .

# Step 6: Expose the port your app runs on (Assuming it's 3000, change if different in server.js)
EXPOSE 3000

# Step 7: Define the command to run the app
CMD ["node", "server.js"]