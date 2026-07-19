import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { loadRootEnv } from './config/root-env';

async function bootstrap() {
  loadRootEnv();
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const provider = (config.get<string>('AI_PROVIDER') || 'claude').toLowerCase();
  const credentialConfigured =
    provider === 'openai'
      ? Boolean(config.get<string>('OPENAI_API_KEY'))
      : Boolean(config.get<string>('ANTHROPIC_API_KEY'));
  const model =
    provider === 'openai'
      ? config.get<string>('OPENAI_MODEL')
      : config.get<string>('ANTHROPIC_MODEL');
  const version = config.get<string>('APP_VERSION') || 'dev';
  const commit = config.get<string>('GIT_SHA') || 'local';
  new Logger('RuntimeConfig').log(
    `version=${version} commit=${commit.slice(0, 12)} AI provider=${provider} model=${model || 'provider-default'} credentials=${credentialConfigured ? 'configured' : 'missing'}`,
  );

  // Behind Traefik / Dokploy reverse proxy: trust X-Forwarded-* so req.secure,
  // req.protocol, and OAuth callback URL construction reflect the original HTTPS request.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // CORS origin 必须与浏览器 Origin 字段精确匹配 (无尾斜杠)。
  // 运维填 FRONTEND_URL 时容易带 / 进来 (URL 心智 vs CORS 规范不一致),
  // 这里统一规范化:strip 末尾任意数量的 / 后再交给 NestJS。
  const frontendUrl = (
    process.env.FRONTEND_URL || 'http://localhost:3000'
  ).replace(/\/+$/, '');
  app.enableCors({
    origin: frontendUrl,
    credentials: true,
  });

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`API running on http://localhost:${port}`);
}

bootstrap();
