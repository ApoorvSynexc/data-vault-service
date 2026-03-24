import { getCrmById, getCrmTokens } from "../../crm";
import { salesforceRequest } from "../salesforce";

const getApexObjects = async (crmId: string) => {
    const crm = await getCrmById(crmId);
    if (!crm) throw new Error('CRM not found');

    const { access_token, refresh_token } = getCrmTokens(crm);
    const instanceUrl = crm.crmProfile?.instanceUrl;
    if (!instanceUrl) throw new Error('Instance URL not found');

    const url = `${instanceUrl}/services/apexrest/v1/accessible-objects`;
    return salesforceRequest(
        { url, method: 'GET' },
        { accessToken: access_token, refreshToken: refresh_token, crmId }
    );
};

const getApexFields = async (crmId: string, objectName: string) => {
    const crm = await getCrmById(crmId);
    if (!crm) throw new Error('CRM not found');

    const { access_token, refresh_token } = getCrmTokens(crm);
    const instanceUrl = crm.crmProfile?.instanceUrl;
    if (!instanceUrl) throw new Error('Instance URL not found');

    const url = `${instanceUrl}/services/apexrest/v1/object-fields-metadata?objectApiName=${objectName}`;
    return salesforceRequest(
        { url, method: 'GET' },
        { accessToken: access_token, refreshToken: refresh_token, crmId }
    );
};

export { getApexObjects, getApexFields };
