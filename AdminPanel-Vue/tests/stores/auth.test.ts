import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const { mockCheckAuthStatus, mockGetCurrentUserInfo, mockLogin } =
  vi.hoisted(() => ({
    mockCheckAuthStatus: vi.fn<() => Promise<boolean>>(),
    mockGetCurrentUserInfo: vi.fn<
      () => Promise<{ username: string; role?: string } | null>
    >(),
    mockLogin: vi.fn<
      (
        payload: { username: string; password: string }
      ) => Promise<{ success: boolean; message?: string }>
    >(),
  }));

vi.mock("@/api", () => ({
  authApi: {
    checkAuthStatus: () => mockCheckAuthStatus(),
    getCurrentUserInfo: () => mockGetCurrentUserInfo(),
    login: (payload: { username: string; password: string }) => mockLogin(payload),
  },
}));

import { useAuthStore } from "@/stores/auth";

describe("auth store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("reuses auth cache within ttl", async () => {
    const store = useAuthStore();

    mockCheckAuthStatus.mockResolvedValue(true);
    mockGetCurrentUserInfo.mockResolvedValue({ username: "alice", role: "admin" });

    const first = await store.checkAuth();
    const second = await store.checkAuth();

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(mockCheckAuthStatus).toHaveBeenCalledTimes(1);
    expect(store.user?.username).toBe("alice");
  });

  it("falls back to login username when profile endpoint unavailable", async () => {
    const store = useAuthStore();

    mockLogin.mockResolvedValue({ success: true });
    mockGetCurrentUserInfo.mockResolvedValue(null);

    const result = await store.login("bob", "secret");

    expect(result.success).toBe(true);
    expect(mockLogin).toHaveBeenCalledWith({ username: "bob", password: "secret" });
    expect(store.user?.username).toBe("bob");
  });
});
