# DataVault Backend - Node.js

A comprehensive backend solution for managing data backups and client services with real-time synchronization capabilities.

## Overview

DataVault Backend is a microservices-based Node.js application that provides secure data backup, management, and recovery solutions. It consists of two core services:

- **Client Service**: Handles user authentication, authorization, backup configuration, and API management
- **Backup Service**: Manages backup job execution, real-time data synchronization, and third-party integrations

## Architecture

### Services

#### Client Service
- User authentication and management
- JWT-based session handling
- Backup job and configuration management
- OTP (One-Time Password) support
- Role-based access control (RBAC)
- Rate limiting and internal authentication
- CRM integration endpoints

#### Backup Service
- Real-time backup job execution
- Scheduled backup operations (cron-based)
- Third-party service integration (Salesforce)
- Destination management for backups
- Backup job tracking and sweeping
- Data encryption and secure transfer

### Technology Stack

**Core Framework**
- Node.js with TypeScript
- Express.js 5.x

**Database & Storage**
- AWS DynamoDB
- AWS S3

**Authentication & Security**
- JWT (jsonwebtoken)
- bcrypt for password hashing
- Custom encryption utilities

**Utilities & Middleware**
- Express rate limiting
- CORS support
- Morgan HTTP request logger
- Winston structured logging
- Joi for validation
- Node-cron for scheduled tasks

**Development Tools**
- TypeScript 5.9
- ESLint with Prettier
- ts-node-dev for development

## Project Structure

```
DataVault-Backend-NodeJS/
├── client-service/
│   ├── src/
│   │   ├── config/          # Configuration management
│   │   ├── controller/      # API request handlers
│   │   ├── models/          # Database models
│   │   ├── services/        # Business logic
│   │   ├── routes/          # API route definitions
│   │   ├── middlewares/     # Custom middleware
│   │   ├── migration/       # Database migrations
│   │   ├── lib/             # Utility libraries
│   │   ├── assets/          # Static assets and localization
│   │   ├── jobs/            # Scheduled jobs
│   │   └── index.ts         # Application entry point
│   ├── dist/                # Compiled JavaScript (generated)
│   └── package.json
│
├── backup-service/
│   ├── src/
│   │   ├── config/          # Configuration management
│   │   ├── controller/      # API request handlers
│   │   ├── models/          # Database models
│   │   ├── services/        # Business logic
│   │   ├── routes/          # API route definitions
│   │   ├── middlewares/     # Custom middleware
│   │   ├── lib/             # Utility libraries
│   │   ├── utils/           # Utility functions (encryption, HTTP)
│   │   ├── assets/          # Localization
│   │   ├── constant/        # Application constants
│   │   └── index.ts         # Application entry point
│   ├── dist/                # Compiled JavaScript (generated)
│   └── package.json
│
└── .gitignore              # Git ignore rules
```

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn
- AWS credentials configured for DynamoDB and S3 access

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd DataVault-Backend-NodeJS
   ```

2. **Install dependencies for both services**
   ```bash
   cd client-service
   npm install
   
   cd ../backup-service
   npm install
   ```

3. **Configure environment variables**
   
   Create `.env` files in both `client-service` and `backup-service` directories:
   
   ```bash
   # Example .env file
   NODE_ENV=development
   PORT=3000
   
   # AWS Configuration
   AWS_REGION=us-east-1
   AWS_ACCESS_KEY_ID=<your-access-key>
   AWS_SECRET_ACCESS_KEY=<your-secret-key>
   
   # Database
   DYNAMODB_TABLE_PREFIX=datavault_
   
   # JWT Configuration
   JWT_SECRET=<your-jwt-secret>
   JWT_EXPIRY=24h
   
   # Other configurations...
   ```

### Development

#### Running Client Service
```bash
cd client-service
npm run dev
```

#### Running Backup Service
```bash
cd backup-service
npm run dev
```

Both services will start with hot-reload enabled via `ts-node-dev`.

### Building

Build and verify the services:

```bash
# In client-service directory
npm run build

# In backup-service directory
npm run build
```

This command runs:
1. Code formatting with Prettier
2. Linting with ESLint
3. TypeScript compilation

### Running in Production

```bash
# Build first
npm run build

# Run the compiled application
npm start
```

### Database Migrations

Run database migrations to set up initial schema:

```bash
cd client-service
npm run migrate
npm run migrate:create-role
```

## API Endpoints

### Client Service

#### Authentication
- `POST /v1/auth/register` - Register new user
- `POST /v1/auth/login` - User login
- `POST /v1/auth/logout` - User logout
- `POST /v1/auth/refresh` - Refresh JWT token

#### Users
- `GET /v1/user` - Get user profile
- `PUT /v1/user` - Update user profile

#### Backup Configuration
- `GET /v1/backup-config` - List backup configurations
- `POST /v1/backup-config` - Create backup configuration
- `PUT /v1/backup-config/:id` - Update configuration
- `DELETE /v1/backup-config/:id` - Delete configuration

#### Backup Jobs
- `GET /v1/backup-job` - List backup jobs
- `POST /v1/backup-job` - Create backup job
- `GET /v1/backup-job/:id` - Get job details
- `PUT /v1/backup-job/:id` - Update job
- `DELETE /v1/backup-job/:id` - Delete job

#### CRM Integration
- `GET /v1/crm` - CRM integration endpoints

#### Public Endpoints
- `POST /v1/public/otp/verify` - Verify OTP
- `POST /v1/public/otp/request` - Request OTP

#### Internal APIs
- Internal service endpoints for inter-service communication

### Backup Service

#### Backup Jobs
- `GET /v1/backup-job` - List backup jobs
- `POST /v1/backup-job` - Create backup job
- `GET /v1/backup-job/:id` - Get job details

#### Real-time Backup
- `POST /v1/realtime-backup` - Execute real-time backup
- `GET /v1/realtime-backup/status` - Get backup status

## Key Features

### Security
- JWT-based authentication
- Password hashing with bcrypt
- Data encryption for sensitive information
- Rate limiting to prevent abuse
- Role-based access control

### Backup Management
- Scheduled backups via cron jobs
- Real-time data synchronization
- Multiple destination support
- Salesforce integration for CRM backups

### Observability
- Structured logging with Winston
- HTTP request logging with Morgan
- Daily rotating log files
- Localized error messages

### Validation
- Input validation with Joi
- Request schema validation
- Type safety with TypeScript

## Environment Configuration

Both services use environment variables for configuration. Key variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Application environment | development |
| `PORT` | Server port | 3000 |
| `AWS_REGION` | AWS region for DynamoDB/S3 | us-east-1 |
| `JWT_SECRET` | Secret key for JWT signing | - |
| `LOG_LEVEL` | Winston logging level | info |

## Development Scripts

### Client Service
```bash
npm run dev          # Start development server
npm run build        # Build for production
npm run start        # Run compiled application
npm run migrate      # Run migrations
npm run lint         # Lint code
npm run format       # Format code with Prettier
```

### Backup Service
```bash
npm run dev          # Start development server
npm run build        # Build for production
npm run start        # Run compiled application
npm run lint         # Lint code
npm run format       # Format code with Prettier
```

## Logging

Logs are managed through Winston and stored in the `logs/` directory:
- Daily rotating log files
- Structured JSON format
- Console output in development

## Contributing

1. Follow the existing code structure and naming conventions
2. Use TypeScript for type safety
3. Run linting and formatting before committing:
   ```bash
   npm run lint
   npm run format
   ```
4. Write clear commit messages

## License

ISC

## Support

For issues or questions, please refer to the project documentation or contact the development team.
