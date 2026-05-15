import { NextFunction, Request, Response } from 'express';
import { makeResponse } from '../../lib';
import { getBackupConfigById } from '../../services/backup-config';

export const webhookAuth = async (req: Request, res: Response, next: NextFunction) => {
  const backupConfigId = req.headers['x-webhook-secret'];

  if(!backupConfigId || typeof backupConfigId !== 'string') {
    return makeResponse(req, res, 401, false, 'unauthorized');
  }

  try {
    const backupConfig = await getBackupConfigById(backupConfigId);
    if (backupConfig) {
      return next();
    }
    return makeResponse(req, res, 401, false, 'unauthorized');
  } catch (error) {
    console.log('Error verifying backup config:', error);
    return makeResponse(req, res, 401, false, 'unauthorized');
  }
};
