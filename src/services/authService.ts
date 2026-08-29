import { UserProfile } from '../types';
import {
  AuthenticatedAthlete,
  signInWithGoogle as firebaseSignInWithGoogle,
  signInWithEmailPassword as firebaseSignInWithEmail,
  createGuestAthlete,
  signOutFromFirebase as firebaseSignOut,
  subscribeToAuthState,
  AuthState,
} from './firebaseAuthService';

export interface UserAccount {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  createdAt: string;
  emailVerified?: boolean;
  profile: UserProfile;
}

export type { AuthState, AuthenticatedAthlete };

export const convertAthleteToUserAccount = (athlete: AuthenticatedAthlete): UserAccount => {
  return {
    id: athlete.uid,
    name: athlete.displayName,
    email: athlete.email,
    avatarUrl: athlete.photoURL,
    createdAt: new Date().toISOString(),
    emailVerified: true,
    profile: athlete.profile,
  };
};

/**
 * Real Firebase Google Sign-In
 */
export const loginWithGoogleAccount = async (): Promise<UserAccount> => {
  const athlete = await firebaseSignInWithGoogle();
  return convertAthleteToUserAccount(athlete);
};

export const loginWithEmailAccount = async (email: string, pass: string): Promise<UserAccount> => {
  const athlete = await firebaseSignInWithEmail(email, pass);
  return convertAthleteToUserAccount(athlete);
};

/**
 * Guest/Test Mode Login Fallback (handles auth/unauthorized-domain seamlessly)
 */
export const loginAsGuestAccount = (name = 'Atleta Convidado'): UserAccount => {
  const athlete = createGuestAthlete(name);
  return convertAthleteToUserAccount(athlete);
};

/**
 * Real Firebase Sign-Out
 */
export const logoutUserAccount = async (): Promise<void> => {
  await firebaseSignOut();
};

/**
 * Update active athlete profile in-memory
 */
export const updateUserAccountProfile = (
  currentUser: UserAccount,
  updatedProfile: UserProfile
): UserAccount => {
  return {
    ...currentUser,
    name: updatedProfile.name,
    profile: updatedProfile,
  };
};

export { subscribeToAuthState };
