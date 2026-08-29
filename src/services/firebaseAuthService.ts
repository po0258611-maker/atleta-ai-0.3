import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  onIdTokenChanged,
  User,
  signOut,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { UserProfile } from '../types';

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);

const googleProvider = new GoogleAuthProvider();
googleProvider.addScope('email');
googleProvider.addScope('profile');
googleProvider.addScope('openid');
googleProvider.setCustomParameters({ prompt: 'select_account' });
auth.useDeviceLanguage();

export type AuthState = 'loading' | 'authenticated' | 'unauthenticated' | 'error';

export interface AuthenticatedAthlete {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  idToken: string;
  emailVerified: boolean;
  /** Firebase account creation time, preserved across session refreshes. */
  createdAt?: string;
  profile: UserProfile;
}

const DEFAULT_ATHLETE_PROFILE: UserProfile = {
  name: 'Atleta', gender: 'male', age: 26, heightCm: 175, weightKg: 75,
  experience: 'intermediate', availableDays: 4, timePerSessionMin: 60,
  objective: 'hypertrophy', environment: 'full_gym',
  priorities: ['peitoral', 'costas', 'quadriceps'], limitations: [],
  forbiddenExercises: [], sleepHours: 8, stressLevel: 'moderate',
};

let currentIdToken: string | null = null;
let currentAthlete: AuthenticatedAthlete | null = null;

export const getIdToken = (): string | null => currentIdToken;
export const getAuthenticatedAthlete = (): AuthenticatedAthlete | null => currentAthlete;

export const getFreshIdToken = async (): Promise<string | null> => {
  const user = auth.currentUser;
  if (!user) return null;
  const token = await user.getIdToken();
  currentIdToken = token;
  return token;
};

const buildProfileFromFirebaseUser = (user: User): UserProfile => ({
  ...DEFAULT_ATHLETE_PROFILE,
  name: user.displayName || 'Atleta Google',
});

export const buildAthleteFromFirebaseUser = async (user: User): Promise<AuthenticatedAthlete> => {
  const token = await user.getIdToken();
  currentIdToken = token;

  const athlete: AuthenticatedAthlete = {
    uid: user.uid,
    email: user.email || 'atleta@google.com',
    displayName: user.displayName || 'Atleta Google',
    photoURL: user.photoURL || undefined,
    idToken: token,
    emailVerified: user.emailVerified,
    createdAt: user.metadata.creationTime || undefined,
    profile: buildProfileFromFirebaseUser(user),
  };

  currentAthlete = athlete;
  return athlete;
};

export const createGuestAthlete = (guestName = 'Atleta Convidado'): AuthenticatedAthlete => {
  const guestUid = `guest_${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11)}`;
  const athlete: AuthenticatedAthlete = {
    uid: guestUid,
    email: 'convidado@treinomax.app',
    displayName: guestName,
    photoURL: undefined,
    idToken: `mock_token_${guestUid}`,
    emailVerified: false,
    createdAt: new Date().toISOString(),
    profile: { ...DEFAULT_ATHLETE_PROFILE, name: guestName },
  };
  currentAthlete = athlete;
  currentIdToken = athlete.idToken;
  return athlete;
};

export const signInWithGoogle = async (): Promise<AuthenticatedAthlete> => {
  const result = await signInWithPopup(auth, googleProvider);
  return buildAthleteFromFirebaseUser(result.user);
};

export const signInWithEmailPassword = async (email: string, password: string): Promise<AuthenticatedAthlete> => {
  const userCred = await signInWithEmailAndPassword(auth, email.trim(), password);
  return buildAthleteFromFirebaseUser(userCred.user);
};

export const registerWithEmailPassword = async (email: string, password: string): Promise<AuthenticatedAthlete> => {
  const userCred = await createUserWithEmailAndPassword(auth, email.trim(), password);
  if (!userCred.user.emailVerified) await sendEmailVerification(userCred.user);
  return buildAthleteFromFirebaseUser(userCred.user);
};

export const sendCurrentUserEmailVerification = async (): Promise<void> => {
  const user = auth.currentUser;
  if (!user) throw new Error('Nenhum usuário autenticado.');
  if (!user.emailVerified) await sendEmailVerification(user);
};

export const refreshCurrentUser = async (): Promise<AuthenticatedAthlete | null> => {
  const user = auth.currentUser;
  if (!user) return null;
  await user.reload();
  return buildAthleteFromFirebaseUser(user);
};

export const sendPasswordReset = async (email: string): Promise<void> => {
  await sendPasswordResetEmail(auth, email.trim());
};

export const signOutFromFirebase = async (): Promise<void> => {
  try {
    await signOut(auth);
  } finally {
    currentIdToken = null;
    currentAthlete = null;
  }
};

export const subscribeToAuthState = (
  onStateChange: (state: AuthState, athlete: AuthenticatedAthlete | null, error?: Error) => void
) => onIdTokenChanged(auth, async (firebaseUser) => {
  if (!firebaseUser) {
    currentIdToken = null;
    currentAthlete = null;
    onStateChange('unauthenticated', null);
    return;
  }

  try {
    onStateChange('authenticated', await buildAthleteFromFirebaseUser(firebaseUser));
  } catch (error: unknown) {
    currentIdToken = null;
    currentAthlete = null;
    onStateChange(
      'error',
      null,
      error instanceof Error ? error : new Error('Erro ao obter token do Firebase.')
    );
  }
}, (error) => {
  currentIdToken = null;
  currentAthlete = null;
  onStateChange('error', null, error);
});
