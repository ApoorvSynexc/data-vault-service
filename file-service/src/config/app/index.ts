import express from 'express';
import { createServer, Server } from 'http';
import { HOST, PORT } from '../../constant';
import { router } from '../../routes';

const app = express();

app.use(express.json({ limit: '10mb' }));

app.use('/api', router);

app.use((_req, res) => {
  res.status(404).send({ success: false, message: 'route_not_found', data: null, meta: {} });
});

export const initializeApp = () => {
  const server: Server = createServer(app);
  server.listen(PORT, HOST, () => {
    console.log(`* App is running at PORT: ${PORT} *`);
  });
};
