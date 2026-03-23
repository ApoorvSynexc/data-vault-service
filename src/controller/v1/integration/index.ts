import { IRequest, IResponse, makeResponse } from "../../../lib";
import { createOAuthState, disconnectIntegration, getIntegrationsByUser, getOAuthState, getSalesforceLoginUrl, getSalesforceProfile, getSalesforceToken, upsertIntegration } from "../../../services";
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

const integrationLoginHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
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

const integrationCodeHanlder = async (req: IRequest, res: IResponse): Promise<void> => {
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

    await upsertIntegration({
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

const integrationListHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const integrations = await getIntegrationsByUser(req.user!.userId);

    makeResponse(req, res, 200, true, 'fetch', integrations.map((integration) => ({
        ...integration,
        encryptedCredentials: undefined,
        iv: undefined,
        authTag: undefined,
    })));
}

const integrationDisconnectHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    const { crmName } = req.query;

    if (!crmName) {
        makeResponse(req, res, 400, false, 'crm_name_required');
        return;
    }

    const integration = await disconnectIntegration(req.user!.userId, String(crmName));

    if (!integration) {
        makeResponse(req, res, 404, false, 'fetch');
        return;
    }

    makeResponse(req, res, 200, true, 'update', {
        ...integration,
        encryptedCredentials: undefined,
        iv: undefined,
        authTag: undefined,
    });
}

export const integratioController = wrapController({
    integrationLoginHanlder,
    integrationCodeHanlder,
    integrationListHandler,
    integrationDisconnectHandler
});
