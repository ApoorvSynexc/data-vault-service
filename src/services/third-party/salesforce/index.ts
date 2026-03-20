import crypto from "crypto";
import { httpRequest } from "../../../utils/http-request";
import { SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET, SALESFORCE_REDIRECT_URI } from "../../../constant";

const AUTH_URL = 'https://login.salesforce.com/services/oauth2/authorize';
const TOKEN_URL = 'https://login.salesforce.com/services/oauth2/token';
const PROFILE_URL = 'https://login.salesforce.com/services/oauth2/userinfo';

function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState() {
    return crypto.randomBytes(16).toString('hex');
}

const getSalesforceLoginUrl = () => {
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    console.log({ state, codeVerifier, codeChallenge });

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: SALESFORCE_CLIENT_ID,
        redirect_uri: SALESFORCE_REDIRECT_URI,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
    });

    return `${AUTH_URL}?${params}`;
};

const getSalesforceToken = async (code: string, code_verifier: string) => {
    try {
        const body = new URLSearchParams({
            'grant_type': 'authorization_code',
            code,
            'client_id': String(SALESFORCE_CLIENT_ID),
            'client_secret': String(SALESFORCE_CLIENT_SECRET),
            'redirect_uri': String(SALESFORCE_REDIRECT_URI),
            code_verifier,
        }).toString();

        const token = await httpRequest({
            url: TOKEN_URL,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body
        });

        return token;
    } catch (error) {
        console.log(error);
        throw error;
    }
}

const getSalesforceProfile = async (token: string) => {
    try {
        const res = await httpRequest({
            url: PROFILE_URL,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`
            },
        });
        return res;
    } catch (error) {
        throw error
    }
}

const refreashSalesforceToken = async (refreshToken: string) => {
    try {
        const token = await httpRequest({
            url: TOKEN_URL,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: {
                'grant_type': 'refresh_token',
                'client_id': SALESFORCE_CLIENT_ID,
                'client_secret': SALESFORCE_CLIENT_SECRET,
                'refresh_token': refreshToken
            }
        });
    } catch (error) {
        throw error;
    }
}

export {
    getSalesforceLoginUrl,
    getSalesforceToken,
    getSalesforceProfile,
    refreashSalesforceToken
}