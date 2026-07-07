// import { IRequest, IResponse, makeResponse } from '../../../lib';
// import { getBackupConfigById } from '../../../services';
// import { wrapController } from '../../../utils/helper';


// const createSparkJobHandler = async (req: IRequest, res: IResponse, next: () => void): Promise<void> => {
//     const { backupConfigId } = req.body;
    
//     const isBackupConfigExist = await getBackupConfigById(backupConfigId);

//     if (!isBackupConfigExist) {
//         makeResponse(req, res, 404, false, 'backup_job_not_found');
//         return; 
//     }

//     if (!backupConfigId) {
//         makeResponse(req, res, 400, false, 'backup_id_required');
//         return; 
//     }
//     next();
// };

// const createPayloadByBackupConfigId = async (req: IRequest, res: IResponse, next: () => void): Promise<void> => {
//     const { backupConfigId } = req.body;
    
//     const isBackupConfigExist = await (backupConfigId);

//     if (!isBackupConfigExist) {
//         makeResponse(req, res, 404, false, 'backup_job_not_found');
//         return; 
//     }

//     if (!backupConfigId) {
//         makeResponse(req, res, 400, false, 'backup_id_required');
//         return; 
//     }
//     next();
// };


// export const sparkJobController = wrapController({
//     createSparkJobHandler
// });