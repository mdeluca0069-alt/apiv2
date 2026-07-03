export type UserServiceState = {
  status: "ready";
  source: "igfxpro-scaffold";
  updatedAt: string;
};

export function UserService(): UserServiceState {
  return {
    status: "ready",
    source: "igfxpro-scaffold",
    updatedAt: new Date().toISOString(),
  };
}

export default UserService;
