import { IRequest, IResponse, makeResponse } from "../../../lib";
import { getSalesforceLoginUrl, getSalesforceToken } from "../../../services";
import { wrapController } from "../../../utils/helper";

const integrationLoginHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const { crmName } = req.query;
    if (!crmName) {
        makeResponse(req, res, 400, false, 'crm_name_required');
    }

    let redirectUrl = '';
    switch (crmName) {
        case 'salesforce':
            redirectUrl = getSalesforceLoginUrl()
            break;
        default:
            redirectUrl = getSalesforceLoginUrl()
    }

    makeResponse(req, res, 200, true, 'fetch', { redirectUrl });
}

const integrationCodeHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const { crmName, code } = req.body;

    let token;
    switch (crmName) {
        case 'salesforce':
            token = await getSalesforceToken(code);
            break;
    }

    console.log({token});
    makeResponse(req, res, 200, true, 'fetch');
}

export const integratioController = wrapController({
    integrationLoginHanlder,
    integrationCodeHanlder
});
