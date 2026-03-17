import { Request, Response } from 'express';

const authHandler = (req: Request, res: Response) => {
  res.send('wokring');
};

export const authController = {
  authHandler,
};
