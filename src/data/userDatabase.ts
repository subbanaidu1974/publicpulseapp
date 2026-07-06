import { UserRole } from "../types";

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  password: string; // Used as the passkey pin
  phone: string;
  role: UserRole;
  districtId: string;
  affiliation: string;
  isPredefined?: boolean;
  createdAt: string;
}

const STORAGE_KEY = "peoplepulse-user-database-v1";

// Default admin and coordinator seed accounts
const DEFAULT_ACCOUNTS: UserProfile[] = [
  {
    id: "super-admin-seed",
    name: "Super Administrator",
    email: "admin@peoplepulse.ap",
    password: "admin", // Secure Passkey PIN
    phone: "9848022338",
    role: UserRole.SuperAdmin,
    districtId: "AP-12",
    affiliation: "AP State Election Committee",
    isPredefined: true,
    createdAt: new Date().toISOString()
  },
  {
    id: "coordinator-seed",
    name: "Nitin Kumar AP SEC",
    email: "nitin.rep@peoplepulse.ap",
    password: "nitin", // Secure Passkey PIN
    phone: "9123456789",
    role: UserRole.FieldCoordinator,
    districtId: "AP-13",
    affiliation: "People's Pulse Research Syndicate",
    isPredefined: true,
    createdAt: new Date().toISOString()
  }
];

// Initialize database in localStorage if empty
export function initUserDatabase(): UserProfile[] {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_ACCOUNTS));
    return DEFAULT_ACCOUNTS;
  }
  try {
    const parsed = JSON.parse(saved) as UserProfile[];
    // Ensure default accounts are present
    let updated = [...parsed];
    let mutated = false;
    DEFAULT_ACCOUNTS.forEach((seed) => {
      if (!updated.some((u) => u.email.toLowerCase() === seed.email.toLowerCase())) {
        updated.push(seed);
        mutated = true;
      }
    });
    if (mutated) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    }
    return updated;
  } catch (error) {
    console.error("Failed to parse user database:", error);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_ACCOUNTS));
    return DEFAULT_ACCOUNTS;
  }
}

export function saveUser(profile: Omit<UserProfile, "id" | "createdAt">): UserProfile {
  const users = initUserDatabase();
  const newUser: UserProfile = {
    ...profile,
    id: "usr_" + Math.random().toString(36).substring(2, 11),
    createdAt: new Date().toISOString()
  };
  
  // Filter out any older duplicate email profile
  const filtered = users.filter((u) => u.email.toLowerCase() !== profile.email.toLowerCase());
  filtered.push(newUser);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
  return newUser;
}

export function checkUserExists(email: string): boolean {
  const users = initUserDatabase();
  return users.some((u) => u.email.toLowerCase() === email.toLowerCase().trim());
}

export function validateUser(email: string, password: string): UserProfile | null {
  const users = initUserDatabase();
  const found = users.find(
    (u) =>
      u.email.toLowerCase() === email.toLowerCase().trim() &&
      u.password === password
  );
  return found || null;
}

export function getAllUsers(): UserProfile[] {
  return initUserDatabase();
}

export function updateUserPassword(email: string, newPassword: string): boolean {
  const users = initUserDatabase();
  const found = users.find((u) => u.email.toLowerCase() === email.toLowerCase().trim());
  if (found) {
    found.password = newPassword;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(users));
    return true;
  }
  return false;
}
