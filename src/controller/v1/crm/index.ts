import { IRequest, IResponse, makeResponse } from "../../../lib";
import { createOAuthState, disconnectCrm, getCrmsByUser, getOAuthState, getSalesforceLoginUrl, getSalesforceProfile, getSalesforceToken, upsertCrm } from "../../../services";
import { wrapController } from "../../../utils/helper";

// Extracts the Salesforce `error` code from httpRequest thrown messages.
// e.g. "HTTP Error 400: {"error":"invalid_grant",...}" → "invalid_grant"
const parseSalesforceError = (error: any): string | null => {
    try {
        const json = error?.message?.replace(/^HTTP Error \d+:\s*/, '');
        return JSON.parse(json)?.error ?? null;
    } catch {
        return null;
    }
};

const crmLoginHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const { crmName } = req.query;
    if (!crmName) {
        makeResponse(req, res, 400, false, 'crm_name_required');
        return;
    }

    const userId = req.user!.userId;
    let redirectUrl = '';

    switch (crmName) {
        case 'salesforce':
        default: {
            const { url, codeVerifier, state } = getSalesforceLoginUrl();
            await createOAuthState(state, codeVerifier, userId, String(crmName));
            redirectUrl = url;
            break;
        }
    }

    makeResponse(req, res, 200, true, 'fetch', { redirectUrl });
}

const crmCodeHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
    const { crmName, code, state } = req.query;

    const oauthState = await getOAuthState(String(state));
    if (!oauthState) {
        makeResponse(req, res, 400, false, 'invalid_or_expired_state');
        return;
    }

    let token;
    try {
        switch (crmName) {
            case 'salesforce':
            default:
                token = await getSalesforceToken(String(code), oauthState.codeVerifier);
                break;
        }
    } catch (error: any) {
        const sfError = parseSalesforceError(error);
        if (sfError === 'invalid_grant') {
            makeResponse(req, res, 400, false, 'salesforce_code_expired');
            return;
        }
        throw error;
    }

    const { data: sfProfile } = await getSalesforceProfile({
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
    });

    const existingCrms = await getCrmsByUser(oauthState.userId);
    const duplicate = existingCrms.find(
        (i) => i.crmProfile?.organizationId === sfProfile.organization_id && i.crmProfile?.userId === sfProfile.user_id
    );
    if (duplicate) {
        makeResponse(req, res, 409, false, 'exit');
        return;
    }

    await upsertCrm({
        userId: oauthState.userId,
        crmName: String(crmName),
        crmProfile: {
            zoneinfo:sfProfile.zoneinfo,
            instanceUrl: token.instance_url,
            organizationId: sfProfile.organization_id,
            userId: sfProfile.user_id,
            name: sfProfile.name,
            email: sfProfile.email,
            username: sfProfile.preferred_username,
            photoUrl: sfProfile.photos?.thumbnail,
        },
        crmCredentials: {
            access_token: token.access_token,
            refresh_token: token.refresh_token,
        },
    });

    makeResponse(req, res, 200, true, 'fetch');
}

const crmListHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const crms = await getCrmsByUser(req.user!.userId);

    makeResponse(req, res, 200, true, 'fetch', crms.map((crm) => ({
        ...crm,
        encryptedCredentials: undefined,
        iv: undefined,
        authTag: undefined,
    })));
}

const crmDisconnectHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const { crmId } = req.query;

    if (!crmId) {
        makeResponse(req, res, 400, false, 'crm_id_required');
        return;
    }

    const crm = await disconnectCrm(String(crmId));

    if (!crm) {
        makeResponse(req, res, 404, false, 'fetch');
        return;
    }

    makeResponse(req, res, 200, true, 'update', {
        ...crm,
        encryptedCredentials: undefined,
        iv: undefined,
        authTag: undefined,
    });
}

export const crmController = wrapController({
    crmLoginHanlder,
    crmCodeHanlder,
    crmListHandler,
    crmDisconnectHandler
});
