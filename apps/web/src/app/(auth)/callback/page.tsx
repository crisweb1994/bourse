'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function CallbackPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/');
  }, [router]);

  return (
    <div className="min-h-screen grid place-items-center bg-[var(--color-bg)]">
      <div className="text-center max-w-[420px] px-6">
        <div className="font-mono text-[12px] text-[var(--color-accent-600)] uppercase tracking-[0.12em]">
          § 登录中
        </div>
        <h1 className="text-[22px] font-semibold tracking-[-0.015em] my-3.5 m-0">
          正在完成登录…
        </h1>
        <p className="text-[14px] text-[var(--color-fg-2)] m-0 leading-[1.55]">
          正在用 GitHub 授权码换取会话 Cookie，稍后将自动跳转到首页。
        </p>
        <div className="progress-indeterminate mt-6" />
        <div className="mt-6 inline-block text-left font-mono text-[11px] text-[var(--color-fg-3)] tracking-[0.04em] leading-[1.95]">
          <div>
            <span className="text-[var(--color-accent-600)] mr-1.5">✓</span>
            从 github.com 接收授权码
          </div>
          <div>
            <span className="text-[var(--color-accent-600)] mr-1.5">✓</span>
            换取访问令牌
          </div>
          <div>
            <span className="text-[var(--color-accent-600)] mr-1.5">✓</span>
            校验权限范围 · read:user · user:email
          </div>
          <div>
            <span className="text-[var(--color-fg-4)] mr-1.5">○</span>
            写入 httpOnly JWT 与 CSRF Cookie
          </div>
          <div>
            <span className="text-[var(--color-fg-4)] mr-1.5">○</span>
            跳转到首页
          </div>
        </div>
      </div>
    </div>
  );
}
