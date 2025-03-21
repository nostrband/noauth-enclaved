# Stage 1: Build
FROM node:22.7-alpine@sha256:ed9736a13b88ba55cbc08c75c9edac8ae7f72840482e40324670b299336680c1 AS build

# Lock environment for reproducibility
ARG SOURCE_DATE_EPOCH
ENV TZ=UTC
WORKDIR /usr/src/app

#RUN echo ${SOURCE_DATE_EPOCH}

# Copy only package-related files first
COPY package*.json ./

# Install dependencies 
RUN npm ci --ignore-scripts

# Copy the rest of the project
COPY . .

# Build project
#RUN npm run build:

# Mac has different default perms vs Linux
RUN chmod go-w .
#RUN chmod -R 644 . ; chmod u+x enclave.sh node_modules/.bin/tsx node_modules/.bin/esbuild

# Stage 3: Server (Node.js)
FROM node:22.7-alpine@sha256:ed9736a13b88ba55cbc08c75c9edac8ae7f72840482e40324670b299336680c1 AS server
WORKDIR /usr/src/app

# Copy only built files and necessary dependencies
COPY --from=build /usr/src/app ./

# socat, tsx
RUN apk add --no-cache socat=1.8.0.0-r0

# remove files generated on MacOS
RUN rm -Rf /root

# Run the server
ENTRYPOINT ["/usr/src/app/enclave.sh"]