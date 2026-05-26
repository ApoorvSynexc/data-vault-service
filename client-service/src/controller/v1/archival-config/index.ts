import { IRequest, IResponse, makeResponse } from "../../../lib";
import { getApexFields, getApexObjectChilds } from "../../../services";
import { wrapController } from "../../../utils/helper";


const getObjectChildHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const { crmId, objectName } = req.query;
    if (!crmId) {
        return makeResponse(req, res, 400, false, 'crm_id_required');
    }

    const [apexResult] = await Promise.all([
        getApexObjectChilds(String(crmId), { objectName }),
    ]);

    makeResponse(req, res, 200, true, 'fetch', { ...apexResult });
};

const getFieldsHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const { crmId, objectName } = req.query;
    if (!crmId) {
        return makeResponse(req, res, 400, false, 'crm_id_required');
    }
    if (!objectName) {
        return makeResponse(req, res, 400, false, 'object_name_required');
    }
    const result = await getApexFields(String(crmId), String(objectName));
    makeResponse(req, res, 200, true, 'fetch', result);
};


export const archivalConfigController = wrapController({
    getObjectChildHanlder,
    getFieldsHanlder
});