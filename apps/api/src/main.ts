import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
