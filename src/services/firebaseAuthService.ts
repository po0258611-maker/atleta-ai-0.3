import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onIdTokenChanged,
  User,
  signOut,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { UserProfile } from '../types';

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

auth.useDeviceLanguage();

export type AuthState = 'loading' | 'authenticated' | 'unauthenticated' | 'error';

export interface AuthenticatedAthlete {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  idToken: string;
  profile: UserProfile;
}

const DEFAULT_ATHLETE_PROFILE: UserProfile = {
  name: 'Atleta',
  gender: 'male',
  age: 26,
  heightCm: 175,
  weightKg: 75,
  experience: 'intermediate',
  availableDays: 4,
  timePerSessionMin: 60,
  objective: 'hypertrophy',
  environment: 'full_gym',
  priorities: ['peitoral', 'costas', 'quadriceps'],
  limitations: [],
  forbiddenExercises: [],
  sleepHours: 8,
  stressLevel: 'moderate',
};

let currentIdToken: string | null = null;
let currentAthlete: AuthenticatedAthlete | null = null;

export const getIdToken = (): string | null => currentIdToken;
export const getAuthenticatedAthlete = (): AuthenticatedAthlete | null => currentAthlete;

/** Returns a fresh Firebase ID token for authenticated API requests. */
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
    profile: buildProfileFromFirebaseUser(user),
  };

  currentAthlete = athlete;
  return athlete;
};

export const createGuestAthlete = (guestName = 'Atleta Convidado'): AuthenticatedAthlete => {
  const guestUid = `guest_${Math.random().toString(36).substring(2, 9)}`;
  const athlete: AuthenticatedAthlete = {
    uid: guestUid,
    email: 'convidado@treinomax.app',
    displayName: guestName,
    photoURL: undefined,
    idToken: `mock_token_${guestUid}`,
    profile: {
      ...DEFAULT_ATHLETE_PROFILE,
      name: guestName,
    },
  };
  currentAthlete = athlete;
  currentIdToken = athlete.idToken;
  return athlete;
};

export const signInWithGoogle = async (): Promise<AuthenticatedAthlete> => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return buildAthleteFromFirebaseUser(result.user);
  } catch (error: any) {
    if (error?.code === 'auth/unauthorized-domain') {
      console.warn('Firebase Auth: Domínio não autorizado no Firebase Console. Utilize o fallback de Atleta Convidado ou Login por E-mail.');
    }
    throw error;
  }
};

export const signInWithEmailPassword = async (email: string, password: string): Promise<AuthenticatedAthlete> => {
  try {
    const userCred = await signInWithEmailAndPassword(auth, email, password);
    return buildAthleteFromFirebaseUser(userCred.user);
  } catch (error: any) {
    if (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential') {
      try {
        const newUserCred = await createUserWithEmailAndPassword(auth, email, password);
        return buildAthleteFromFirebaseUser(newUserCred.user);
      } catch (createErr) {
        throw createErr;
      }
    }
    throw error;
  }
};

export const signOutFromFirebase = async (): Promise<void> => {
  try {
    await signOut(auth);
  } finally {
    currentIdToken = null;
    currentAthlete = null;
  }
};

/**
 * Observes both sign-in state and token refreshes. This prevents API calls from
 * continuing to use an expired Firebase ID token after automatic refresh.
 */
export const subscribeToAuthState = (
  onStateChange: (state: AuthState, athlete: AuthenticatedAthlete | null, error?: Error) => void
) => {
  return onIdTokenChanged(
    auth,
    async (firebaseUser) => {
      if (!firebaseUser) {
        currentIdToken = null;
        currentAthlete = null;
        onStateChange('unauthenticated', null);
        return;
      }

      try {
        const athlete = await buildAthleteFromFirebaseUser(firebaseUser);
        onStateChange('authenticated', athlete);
      } catch (error: unknown) {
        currentIdToken = null;
        currentAthlete = null;
        const normalized = error instanceof Error ? error : new Error('Erro ao obter token do Firebase.');
        onStateChange('error', null, normalized);
      }
    },
    (error) => {
      currentIdToken = null;
      currentAthlete = null;
      onStateChange('error', null, error);
    }
  );
};
