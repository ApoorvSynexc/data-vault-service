import express from 'express';
import { createServer, Server } from 'http';
import { router } from '../../routes';
import { morganMiddleware } from '../../middlewares';
import { makeResponse } from '../../lib';

const PORT = Number(process.env.PORT) || 3000;
const HOST: string = String(process.env.HOST || '0.0.0.0');
const app = express();

app.use(express.json({limit: "10mb"}));
app.use(morganMiddleware);

app.use('/api', router);

app.use((req, res) => {
  makeResponse(req, res, 404, false, 'route_not_found');
});

export const initializeApp = () => {
  const server: Server = createServer(app);
  server.listen(PORT, HOST, async () => {
    console.log(`* App is running at PORT: ${PORT} *`);
  });
};
