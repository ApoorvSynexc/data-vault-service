import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { OpenAPIV3 } from 'openapi-types';
import type { SwaggerUiOptions } from 'swagger-ui-express';

// Read directly off disk (rather than `import`) so this module stays under `rootDir`
// in both the src (dev) and dist (prod) layouts, which sit at the same relative depth.
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf-8')
) as { version: string };

// The spec is authored entirely as YAML assets (postbuild copies this folder into
// dist): openapi.yaml holds info/servers/tags/components, and each file under
// paths/ holds the OpenAPI `paths` object for one route module — kept alongside
// (not inside) the code so it can be edited and reviewed without touching routes.
const swaggerAssetsDir = path.join(__dirname, '..', '..', 'assets', 'swagger');
const pathsDir = path.join(swaggerAssetsDir, 'paths');

const loadYaml = <T>(filePath: string): T => yaml.load(fs.readFileSync(filePath, 'utf-8')) as T;

const swaggerDefinition = loadYaml<OpenAPIV3.Document>(path.join(swaggerAssetsDir, 'openapi.yaml'));
swaggerDefinition.info.version = packageJson.version;
swaggerDefinition.paths = fs
  .readdirSync(pathsDir)
  .filter((file) => file.endsWith('.yaml'))
  .reduce<OpenAPIV3.PathsObject>(
    (paths, file) => ({ ...paths, ...loadYaml<OpenAPIV3.PathsObject>(path.join(pathsDir, file)) }),
    {}
  );

const swaggerSpec = swaggerDefinition;

// swagger-ui-express display options — a calmer, branded look over the stock UI.
const swaggerUiOptions: SwaggerUiOptions = {
  customSiteTitle: 'DataVault API Docs',
  customCss: `
    .swagger-ui .topbar { background-color: #10151b; }
    .swagger-ui .topbar .download-url-wrapper { display: none; }
    .swagger-ui .info .title { color: #10151b; }
    .swagger-ui .scheme-container { box-shadow: none; border-bottom: 1px solid #e3e8ee; }
  `,
  swaggerOptions: {
    persistAuthorization: true,
    docExpansion: 'list',
    filter: true,
    tagsSorter: 'alpha',
    operationsSorter: 'alpha',
  },
};

export { swaggerSpec, swaggerUiOptions };
