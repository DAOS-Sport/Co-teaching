import { useQuery } from "@tanstack/react-query";
import type { UserDto as User } from "@shared/contracts";

export function useAuth() {
  // For public deployment, disable automatic auth queries to prevent Replit Auth redirects
  const { data: user, isLoading } = useQuery<User>({
    queryKey: ["/api/auth/user"],
    retry: false,
    enabled: false, // Disable automatic user fetching for public access
  });

  return {
    user: user || null,
    isLoading: false, // Always set to false since we're not loading
    isAuthenticated: false, // Always false for public access
  };
}
