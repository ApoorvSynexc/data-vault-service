import { IRequest, IResponse, makeResponse } from "../../../lib";
import { getApexFields, getApexObjects } from "../../../services";
import { wrapController } from "../../../utils/helper";

const getObjectsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const {crmId} = req.query;
    if(!crmId) return makeResponse(req, res, 400, false, 'crm_id_required');    
    const test = await getApexObjects(String(crmId));
    makeResponse(req, res, 200, true, 'fetch', test);
}

const getFieldsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const {crmId, objectName} = req.query;
    if(!crmId) return makeResponse(req, res, 400, false, 'crm_id_required');  
    if(!objectName) return makeResponse(req, res, 400, false, 'object_name_required');  
    const test = await getApexFields(String(crmId), String(objectName));
    makeResponse(req, res, 200, true, 'fetch', test);
}

export const backupConfigController = wrapController({
    getObjectsHanlder,
    getFieldsHanlder
});
