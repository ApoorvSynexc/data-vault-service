import { httpRequest } from "../../../utils/http-request";
import { SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET, SALESFORCE_REDIRECT_URI } from "../../../constant";

const AUTH_URL = 'https://login.salesforce.com/services/oauth2/authorize';
const TOKEN_URL = 'https://login.salesforce.com/services/oauth2/token';

const getSalesforceLoginUrl = () => {
    return `${AUTH_URL}?client_id=${SALESFORCE_CLIENT_ID}&redirect_uri=${SALESFORCE_REDIRECT_URI}&response_type=code`;
};

const getSalesforceToken = async(code: string) => {
    try {
        const token = await httpRequest({
            url: TOKEN_URL,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: {
                'grant_type': 'authorization_code',
                'client_id': String(SALESFORCE_CLIENT_ID),
                'client_secret': String(SALESFORCE_CLIENT_SECRET),
                'redirect_uri': String(SALESFORCE_REDIRECT_URI),
                'code': code
            }
        });

        return token;
    } catch (error) {
        throw error;
    }
}

const refreashSalesforceToken = async(refreshToken: string) => {
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
        })
    } catch (error) {
        throw error;
    }
}   

export {
    getSalesforceLoginUrl,
    getSalesforceToken,
    refreashSalesforceToken
}