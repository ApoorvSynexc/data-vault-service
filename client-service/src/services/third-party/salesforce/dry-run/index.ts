import { executeDryRun } from './executor';
import type { IDryRunPayload, IDryRunResult } from './types';

export type { IDryRunPayload, IDryRunResult, IDryRunObjectResult, IValidateSoqlPayload, IValidateSoqlItem } from './types';

const dryRun = async (payload: IDryRunPayload): Promise<IDryRunResult> => executeDryRun(payload);

export { dryRun };
export { validateSoql } from './validate-soql';
