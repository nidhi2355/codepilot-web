export interface UserProfile {
  id: number;
  github_id: number;
  username: string;
  avatar_url: string | null;
  email: string | null;
}

export interface AuthSession {
  access_token: string;
  token_type: string;
  user: UserProfile;
}