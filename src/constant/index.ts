const HOST = String(process.env.MONGO_HOST);
const PORT = String(process.env.MONGO_PORT);
const DB = String(process.env.MONGO_DATABASE);
const USER = String(process.env.MONGO_USER);
const PASSWORD = String(process.env.MONGO_PASSWORD);

export { HOST, PORT, DB, USER, PASSWORD };
