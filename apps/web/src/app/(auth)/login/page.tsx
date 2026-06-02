'use client';

import { Github } from 'lucide-react';
import { API_URL } from '@/lib/utils';
import { SectionTag } from '@/components/ui';

export default function LoginPage() {
  return (
    <div className="min-h-screen grid place-items-center bg-[var(--color-bg)] px-6">
      <div className="w-full max-w-[380px] text-center">
        <div className="mb-7 flex items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/bourse-logo.svg" alt="Bourse" className="h-9 w-auto" />
        </div>

        <SectionTag className="mb-3.5 justify-center w-full">登录</SectionTag>
        <h1 className="text-[24px] font-semibold tracking-[-0.015em] leading-[1.2] mb-2.5 m-0">
          欢迎回来
        </h1>
        <p className="text-[13.5px] text-[var(--color-fg-2)] m-0 leading-[1.65]">
          Bourse 使用 GitHub 登录，无需密码。会话以 httpOnly JWT cookie
          配合 CSRF 双提交保护。
        </p>

        <a
          href={`${API_URL}/api/auth/github`}
          className={
            'mt-7 flex items-center justify-center gap-2 ' +
            'h-11 w-full rounded-[var(--radius-btn)] ' +
            'bg-[var(--color-fg)] text-[var(--color-bg)] ' +
            'border border-[var(--color-fg)] ' +
            'font-medium text-[13.5px] ' +
            'transition-colors hover:bg-[#1f1f1f]'
          }
        >
          <Github className="w-4 h-4" strokeWidth={1.5} />
          使用 GitHub 登录
        </a>

        <div className="mt-3.5 font-mono text-[10.5px] text-[var(--color-fg-3)] tracking-[0.04em]">
          继续即表示同意
          <span className="border-b border-[var(--color-fg-4)] pb-px mx-1">服务条款</span>
          与
          <span className="border-b border-[var(--color-fg-4)] pb-px mx-1">隐私政策</span>
        </div>
      </div>
    </div>
  );
}
