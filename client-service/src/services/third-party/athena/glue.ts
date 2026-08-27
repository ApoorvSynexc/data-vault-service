import { GlueClient, GetTableCommand, EntityNotFoundException } from '@aws-sdk/client-glue';
import { AWS_REGION, AWS_ACCESS_KEY, AWS_SECRET_KEY } from '../../../constant';
import { logger } from '../../../middlewares';
import { IAwsCredentials } from '../../../models';

// constant/index.ts builds these with String(process.env.X), so an unset var
// reads back as the literal string "undefined" rather than undefined itself —
// excluded here so a deployed environment without these set doesn't send AWS
// a literal accessKeyId of "undefined" (a real, previously-hit QA bug).
const isSet = (value: string): boolean => Boolean(value) && value !== 'undefined';

const awsCredentials: IAwsCredentials = {
  region: AWS_REGION,
};

if (isSet(AWS_ACCESS_KEY) && isSet(AWS_SECRET_KEY)) {
  awsCredentials.credentials = {
    accessKeyId: AWS_ACCESS_KEY,
    secretAccessKey: AWS_SECRET_KEY,
  };
}

const glue = new GlueClient(awsCredentials);

// Whether a Glue table exists — checked before counting records so an object
// that simply hasn't been compressed yet (no backup job has run for it) reads
// as "0 records", not an Athena failure, while a genuine Glue/Athena error
// still throws. Mirrors backup-service's own glueTableExists
// (services/third-party/glue/index.ts) — not reusable here directly, since
// client-service never imports backup-service code.
export const tableExists = async (databaseName: string, tableName: string): Promise<boolean> => {
  try {
    await glue.send(new GetTableCommand({ DatabaseName: databaseName, Name: tableName }));
    return true;
  } catch (err: any) {
    if (err instanceof EntityNotFoundException || err?.name === 'EntityNotFoundException') {
      return false;
    }
    logger.error(`[glue] tableExists failed | db:${databaseName} table:${tableName} err:${err?.name}: ${err?.message}`);
    throw err;
  }
};
