import {
  EventBridgeClient,
  CreateConnectionCommand,
  CreateApiDestinationCommand,
  DescribeApiDestinationCommand,
  DescribeConnectionCommand,
} from '@aws-sdk/client-eventbridge';
import { logger } from '../../middlewares/logger';

const eventBridgeClient = new EventBridgeClient({ region: process.env.AWS_REGION || 'us-east-1' });

const DESTINATION_NAME = 'backup-trigger-destination';
const CONNECTION_NAME = 'backup-trigger-connection';

export const getOrCreateApiDestination = async (
  invocationEndpoint: string
): Promise<{ destinationArn: string; connectionArn: string }> => {
  try {
    // Try to get existing destination and connection
    try {
      const response = await eventBridgeClient.send(
        new DescribeApiDestinationCommand({ Name: DESTINATION_NAME })
      );
      if (response.ApiDestinationArn) {
        logger.info(`Using existing API Destination: ${DESTINATION_NAME}`);
        return {
          destinationArn: response.ApiDestinationArn,
          connectionArn: response.ConnectionArn || '',
        };
      }
    } catch (error) {
      if ((error as any)?.name !== 'ResourceNotFoundException') {
        throw error;
      }
      // Destination doesn't exist, will create it
    }

    // Get or create connection
    let connectionArn: string;
    try {
      const connectionResponse = await eventBridgeClient.send(
        new DescribeConnectionCommand({ Name: CONNECTION_NAME })
      );
      if (connectionResponse.ConnectionArn) {
        logger.info(`Using existing connection: ${CONNECTION_NAME}`);
        connectionArn = connectionResponse.ConnectionArn;
      } else {
        throw new Error('Connection exists but no ARN returned');
      }
    } catch (error) {
      if ((error as any)?.name !== 'ResourceNotFoundException') {
        throw error;
      }
      // Connection doesn't exist, create it
      const createConnResponse = await eventBridgeClient.send(
        new CreateConnectionCommand({
          Name: CONNECTION_NAME,
          Description: 'Connection for backup trigger HTTP endpoint',
          AuthorizationType: 'BASIC',
          AuthParameters: {
            BasicAuthParameters: {
              Username: 'backup',
              Password: process.env.INTERNAL_SECRET || 'backup-secret',
            },
          },
        })
      );

      if (!createConnResponse.ConnectionArn) {
        throw new Error('Failed to create connection');
      }
      connectionArn = createConnResponse.ConnectionArn;
      logger.info(`Created connection: ${CONNECTION_NAME}`);
    }

    // Create API destination
    const destinationResponse = await eventBridgeClient.send(
      new CreateApiDestinationCommand({
        Name: DESTINATION_NAME,
        Description: 'API Destination for backup trigger',
        ConnectionArn: connectionArn,
        InvocationEndpoint: invocationEndpoint,
        HttpMethod: 'POST',
        InvocationRateLimitPerSecond: 10,
      })
    );

    if (!destinationResponse.ApiDestinationArn) {
      throw new Error('Failed to create API Destination');
    }

    logger.info(`Created API Destination: ${DESTINATION_NAME}`, {
      arn: destinationResponse.ApiDestinationArn,
    });

    return {
      destinationArn: destinationResponse.ApiDestinationArn,
      connectionArn,
    };
  } catch (error) {
    logger.error('Failed to get or create API Destination', error);
    throw error;
  }
};
