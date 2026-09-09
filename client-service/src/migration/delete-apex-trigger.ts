import { deleteTriggers, getUserByCrmProfileUserId } from "../services"
import { decrypt } from "../utils/encryption";

export const deleteUserTrigger = async () => {
    try {
        const backupConfig: any = {
            triggerResults: [
                {
                    triggerName: "DataVault_Lead_Trigger",
                    status: 'CREATED'
                },
                {
                    triggerName: "DataVault_UserPrioritizedRecord_Trigger",
                    status: 'CREATED'
                },
                // {
                //     triggerName: "DataVault_Product2_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Employee_Document_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Decision_Country_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Salary_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Task_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Employee_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Pricebook2_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Hospital_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Opportunity_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_ProfileSkillUser_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Company_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Account_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_University_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Course_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_DataVault_Test_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_WorkOrder_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Case_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_SocialPersona_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_ProfileSkill_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_ProfileSkillEndorsement_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_ContactRequest_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Faculty_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Macro_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_EmailMessage_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_UserProvisioningLog_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Student_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Note_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Contact_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_ContactPointPhone_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Leave_Request_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Division_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Exam_Result_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_AuthorizationFormText_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Solution_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_CommSubscriptionConsent_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_OpportunityContactRole_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_PartyConsent_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Department_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Contract_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Performance_Review_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Customer_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Project_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Timesheet_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_QuickText_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_TopicAssignment_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_CaseComment_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_ContactPointConsent_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_BusinessBrand_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_ProcessException_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_ContactPointAddress_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Property_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Quote_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_DataUsePurpose_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_TableauHostMapping_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_EngagementChannelType_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_CommSubscriptionChannelType_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_AuthorizationForm_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_AuthorizationFormDataUse_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_DataUseLegalBasis_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_CollaborationGroup_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_CollaborationGroupRecord_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_CommSubscription_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_ContactPointEmail_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_ContactPointTypeConsent_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_UserProvisioningRequest_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_Individual_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_UserProvMockTarget_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_SocialPost_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_SetupAssistantStep_Trigger",
                //     status: 'CREATED'
                // },
                // {
                //     triggerName: "DataVault_WorkOrderLineItem_Trigger",
                //     status: 'CREATED'
                // },
            ]
        }
        const user = await getUserByCrmProfileUserId("005dN00000B4141QAB", ""); // TODO: fill in orgId before running
        if (true) {
            console.log("Deleting trigger");

            // const tokens = JSON.parse(decrypt(user.crmCredential));
            // console.log({tokens});
            const count = await deleteTriggers(
                "https://hyudaitextolic.my.salesforce-setup.com/",
                {
                    //accessToken: "",
                    accessToken: "",
                    refreshToken: "",
                },
                backupConfig
            );
            console.log(`Trigger deleted length: ${count.length}`);
            console.log(JSON.stringify({count}));
            
        }
    } catch (error) {
        console.log("Error in migration: ", error);

    }
}