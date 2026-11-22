/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, FormEvent, useEffect, useMemo } from "react";
import { Vote, Shield, ShieldAlert, Info, FileText, CheckCircle2, Award, BookOpen, Newspaper, Send, LogIn, ChevronRight, Download, Eye, EyeOff, Loader2, MessageSquare, AlertCircle, FileLock, Play, Tv, ExternalLink, ThumbsUp, ThumbsDown, Bookmark } from "lucide-react";
import { UserRole, SurveyResponse, District, NewsVideo } from "./types";
import { DISTRICTS, CONSTITUENCIES, REPORTS, NEWS_CARDS, TESTIMONIALS, INITIAL_MOCK_RESPONSES, TRENDING_VIDEOS } from "./data/staticData";
import { initUserDatabase, saveUser, validateUser, checkUserExists, UserProfile, updateUserPassword, getAllUsers } from "./data/userDatabase";

import Navbar from "./components/Navbar";
import InteractiveMap from "./components/InteractiveMap";
import DistrictComparisonTable from "./components/DistrictComparisonTable";
import DashboardWidgets from "./components/DashboardWidgets";
import SurveyForm from "./components/SurveyForm";
import ConstituencyPage from "./components/ConstituencyPage";
import AdminPortal from "./components/AdminPortal";
import HomeMap from "./components/HomeMap";
import FAQPage from "./components/FAQPage";
import ElectionsPage from "./components/ElectionsPage";
import CivicHome from "./components/civic/CivicHome";
import ConstituencySearch from "./components/ConstituencySearch";
import MapLayers from "./components/MapLayers";
import DataStatusPanel from "./components/DataStatusPanel";
import { DemoBadge } from "./components/ui";
import { StateProvider, useStateCtx, defaultYear } from "./state/StateContext";
import { LangProvider, useT } from "./i18n";

function AppInner() {
  const [theme, setTheme] = useState<"beige" | "dark" | "dark-beige" | "earth-yellow">(() => {
    const saved = localStorage.getItem("app-theme");
    if (saved === "beige" || saved === "dark" || saved === "dark-beige" || saved === "earth-yellow") {
      return saved as "beige" | "dark" | "dark-beige" | "earth-yellow";
    }
    return "beige";
  });

  const [registeredUsersCount, setRegisteredUsersCount] = useState<number>(() => {
    const saved = localStorage.getItem("registered-users-count-live-v1");
    return saved ? parseInt(saved, 10) : 0;
  });

  const [loggedPollsCount, setLoggedPollsCount] = useState<number>(() => {
    const saved = localStorage.getItem("logged-polls-count-live-v1");
    return saved ? parseInt(saved, 10) : 0;
  });

  useEffect(() => {
    localStorage.setItem("app-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("registered-users-count-live-v1", registeredUsersCount.toString());
  }, [registeredUsersCount]);

  useEffect(() => {
    localStorage.setItem("logged-polls-count-live-v1", loggedPollsCount.toString());
  }, [loggedPollsCount]);

  useEffect(() => {
    initUserDatabase();
  }, []);
  const [currentTab, setCurrentTab] = useState<string>("home");
  const { state: stateCode, config: stateCfg } = useStateCtx();
  const { t, lang } = useT();
  const isAP = stateCode === "AP";
  useEffect(() => {
    const on = (e: Event) => setCurrentTab(String((e as CustomEvent).detail));
    window.addEventListener("pp-nav", on);
    return () => window.removeEventListener("pp-nav", on);
  }, []);
  const stateDisplayName = lang === "te" ? stateCfg.nameTe : stateCfg.name;
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(() => {
    return localStorage.getItem("is-logged-in") === "true";
  });
  const [currentUserRole, setCurrentUserRole] = useState<UserRole>(() => {
    const saved = localStorage.getItem("current-user-role");
    return (saved as UserRole) || UserRole.Citizen;
  });
  const [currentUserEmail, setCurrentUserEmail] = useState<string>(() => {
    return localStorage.getItem("current-user-email") || "";
  });

  useEffect(() => {
    localStorage.setItem("is-logged-in", isLoggedIn.toString());
  }, [isLoggedIn]);

  useEffect(() => {
    localStorage.setItem("current-user-role", currentUserRole);
  }, [currentUserRole]);

  useEffect(() => {
    localStorage.setItem("current-user-email", currentUserEmail);
  }, [currentUserEmail]);

  const [selectedDistrictId, setSelectedDistrictId] = useState<string>("AP-12"); // default to NTR district
  
  // Dynamic list of submitted survey responses (statefully managed)
  const [surveyResponses, setSurveyResponses] = useState<SurveyResponse[]>(INITIAL_MOCK_RESPONSES);

  // States for Login form
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginRole, setLoginRole] = useState<UserRole>(UserRole.SuperAdmin);
  const [loginError, setLoginError] = useState("");
  const [loginSuccessMessage, setLoginSuccessMessage] = useState("");
  const [loginSubStep, setLoginSubStep] = useState<1 | 2>(1);
  const [loginPhone, setLoginPhone] = useState("");
  const [loginOtpChoice, setLoginOtpChoice] = useState<"email" | "phone">("email");
  const [loginOtpInput, setLoginOtpInput] = useState("");
  const [dispatchedOtp, setDispatchedOtp] = useState("");
  const [otpDispatchedMessage, setOtpDispatchedMessage] = useState("");
  const [validatedUserObj, setValidatedUserObj] = useState<UserProfile | null>(null);
  const [confirmResetPolls, setConfirmResetPolls] = useState(false);

  // Password reset/forgot password state variables
  const [isForgotMode, setIsForgotMode] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotStep, setForgotStep] = useState<1 | 2 | 3>(1);
  const [forgotOtp, setForgotOtp] = useState("");
  const [forgotOtpInput, setForgotOtpInput] = useState("");
  const [forgotNewPassword, setForgotNewPassword] = useState("");
  const [forgotError, setForgotError] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotSuccessMessage, setForgotSuccessMessage] = useState("");
  const [showForgotNewPassword, setShowForgotNewPassword] = useState(false);

  // Strong password checker (Min 6 chars, at least 1 letter, at least 1 number)
  const isPasswordValid = (pw: string): boolean => {
    if (pw.length < 6) return false;
    const hasLetter = /[a-zA-Z]/.test(pw);
    const hasNumber = /[0-9]/.test(pw);
    return hasLetter && hasNumber;
  };

  // States for Signup Wizard (3-step registration process)
  const [isSigningUp, setIsSigningUp] = useState(false);
  const [signupStep, setSignupStep] = useState(1);
  const [signupName, setSignupName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [signupPhone, setSignupPhone] = useState("");
  const [signupRole, setSignupRole] = useState<UserRole>(UserRole.SuperAdmin);
  const [signupDistrictId, setSignupDistrictId] = useState("AP-12");
  const [signupAffiliation, setSignupAffiliation] = useState("");
  const [signupOathChecked, setSignupOathChecked] = useState(false);
  const [signupError, setSignupError] = useState("");
  const [signupSuccess, setSignupSuccess] = useState(false);

  // States for Contact Form
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactOrg, setContactOrg] = useState("");
  const [contactMessage, setContactMessage] = useState("");
  const [contactFeedback, setContactFeedback] = useState("");

  // Filter states for news
  const [newsFilter, setNewsFilter] = useState("all");
  const [activeVideo, setActiveVideo] = useState<NewsVideo>(TRENDING_VIDEOS[0]);
  const [videoFilter, setVideoFilter] = useState<string>("all");
  const [playerMode, setPlayerMode] = useState<"hd-native" | "youtube">("hd-native");

  const [autoplayNext, setAutoplayNext] = useState<boolean>(true);
  const [autoplayCountdown, setAutoplayCountdown] = useState<number>(30);
  const [isAutoplayPaused, setIsAutoplayPaused] = useState<boolean>(false);

  const [videoReactions, setVideoReactions] = useState<Record<string, { liked: boolean; disliked: boolean; bookmarked: boolean; likesCount: number; dislikesCount: number }>>({
    "VID-01": { liked: false, disliked: false, bookmarked: false, likesCount: 245, dislikesCount: 12 },
    "VID-02": { liked: false, disliked: false, bookmarked: false, likesCount: 412, dislikesCount: 34 },
    "VID-03": { liked: false, disliked: false, bookmarked: false, likesCount: 189, dislikesCount: 8 },
    "VID-04": { liked: false, disliked: false, bookmarked: false, likesCount: 320, dislikesCount: 56 },
    "VID-05": { liked: false, disliked: false, bookmarked: false, likesCount: 278, dislikesCount: 45 },
  });

  const handleVideoReaction = (videoId: string, action: "like" | "dislike" | "bookmark") => {
    setVideoReactions(prev => {
      const current = prev[videoId] || { liked: false, disliked: false, bookmarked: false, likesCount: 150, dislikesCount: 10 };
      const updated = { ...current };

      if (action === "like") {
        if (updated.liked) {
          updated.liked = false;
          updated.likesCount = Math.max(0, updated.likesCount - 1);
        } else {
          updated.liked = true;
          updated.likesCount += 1;
          if (updated.disliked) {
            updated.disliked = false;
            updated.dislikesCount = Math.max(0, updated.dislikesCount - 1);
          }
        }
      } else if (action === "dislike") {
        if (updated.disliked) {
          updated.disliked = false;
          updated.dislikesCount = Math.max(0, updated.dislikesCount - 1);
        } else {
          updated.disliked = true;
          updated.dislikesCount += 1;
          if (updated.liked) {
            updated.liked = false;
            updated.likesCount = Math.max(0, updated.likesCount - 1);
          }
        }
      } else if (action === "bookmark") {
        updated.bookmarked = !updated.bookmarked;
      }

      return {
        ...prev,
        [videoId]: updated
      };
    });
  };

  const selectedDistrict = DISTRICTS.find(d => d.id === selectedDistrictId) || DISTRICTS[11];

  const handleSelectDistrict = (districtId: string) => {
    setSelectedDistrictId(districtId);
  };

  // Add survey response and update totals count state
  const handleAddResponse = (newResponse: SurveyResponse) => {
    setSurveyResponses((prev) => [newResponse, ...prev]);
    setLoggedPollsCount((prev) => prev + 1);
    
    // Programmatically hook response to trigger weight updates for active preview session
    const matchingDistrict = DISTRICTS.find((d) => d.id === newResponse.districtId);
    if (matchingDistrict) {
      matchingDistrict.totalResponses += 1;
    }
    const matchingAC = CONSTITUENCIES.find((ac) => ac.id === newResponse.constituencyId);
    if (matchingAC) {
      matchingAC.surveyResponses += 1;
      // Slightly push approval rating based on govtRating to demonstrate live interaction
      if (newResponse.govtRating > 3) {
        matchingAC.approvalRating = Math.min(98, matchingAC.approvalRating + 1);
      }
    }
  };

  const handleApproveResponse = (id: string) => {
    setSurveyResponses(prev =>
      prev.map(r => r.id === id ? { ...r, status: "Approved" as const } : r)
    );
  };

  const handleFlagResponse = (id: string) => {
    setSurveyResponses(prev =>
      prev.map(r => r.id === id ? { ...r, status: "Flagged" as const } : r)
    );
  };

  // Handle Admin Auth (Gateway Credentials with Password -> OTP Verification)
  const handleLogin = (e: FormEvent) => {
    e.preventDefault();
    if (loginLoading) return;
    
    if (loginSubStep === 1) {
      if (!loginEmail) {
        setLoginError("Please enter a valid administrator or observer email.");
        return;
      }
      if (!loginPassword) {
        setLoginError("Please provide your account password.");
        return;
      }

      const emailKey = loginEmail.toLowerCase().trim();
      const lockDataStr = localStorage.getItem(`auth_lock_${emailKey}`);
      if (lockDataStr) {
        try {
          const lockData = JSON.parse(lockDataStr);
          if (lockData.lockedUntil && Date.now() < lockData.lockedUntil) {
            const minsLeft = Math.ceil((lockData.lockedUntil - Date.now()) / 60000);
            setLoginError(`This account is locked due to 3 failed password attempts. Use "Forgot Password" or try again in ${minsLeft} minute${minsLeft === 1 ? "" : "s"}.`);
            return;
          } else {
            localStorage.removeItem(`auth_lock_${emailKey}`);
            localStorage.removeItem(`auth_failed_${emailKey}`);
          }
        } catch (err) {}
      }

      setLoginLoading(true);
      setLoginError("");
      setLoginSuccessMessage("");

      setTimeout(() => {
        // Check users database for registered user match
        const matchedUser = validateUser(loginEmail, loginPassword);
        if (!matchedUser) {
          let failedCount = 0;
          const rawAttempts = localStorage.getItem(`auth_failed_${emailKey}`);
          if (rawAttempts) {
            failedCount = parseInt(rawAttempts, 10);
          }
          failedCount += 1;
          localStorage.setItem(`auth_failed_${emailKey}`, failedCount.toString());

          if (failedCount >= 3) {
            const lockedUntil = Date.now() + 30 * 60 * 1000;
            localStorage.setItem(`auth_lock_${emailKey}`, JSON.stringify({ lockedUntil }));
            localStorage.removeItem(`auth_failed_${emailKey}`);
            setLoginError("This security profile has been locked for 30 minutes due to 3 consecutive failed password attempts.");
          } else {
            const attemptsLeft = 3 - failedCount;
            if (checkUserExists(loginEmail)) {
              setLoginError(`The password entered is incorrect for this registered observer profile. (${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} remaining before a 30-minute lock)`);
            } else {
              setLoginError(`No administrator or observer profile is registered under this email address. (${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} remaining before a 30-minute lock)`);
            }
          }
          setLoginLoading(false);
          return;
        }

        // Correct credentials - clean security locks
        localStorage.removeItem(`auth_failed_${emailKey}`);
        localStorage.removeItem(`auth_lock_${emailKey}`);

        // If choosing SMS (phone) route, validate phone matching the registered user profile
        if (loginOtpChoice === "phone") {
          if (!loginPhone.trim()) {
            setLoginError("Please enter the mobile contact registered to this profile.");
            setLoginLoading(false);
            return;
          }
          const userPhoneNorm = matchedUser.phone.replace(/[\s\-\+\(\)]/g, "");
          const inputPhoneNorm = loginPhone.replace(/[\s\-\+\(\)]/g, "");
          if (userPhoneNorm !== inputPhoneNorm) {
            setLoginError(`The phone contact does not match the registered observer profile (${matchedUser.phone}).`);
            setLoginLoading(false);
            return;
          }
        }

        setValidatedUserObj(matchedUser);
        
        // Generate a structured 6-digit verification code
        const generatedCode = Math.floor(100000 + Math.random() * 900000).toString();
        
        const destinationLabel = loginOtpChoice === "email" ? matchedUser.email : matchedUser.phone;
        
        // Real-time server-side API call to send OTP email
        fetch("/api/send-otp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: matchedUser.email,
            phone: matchedUser.phone,
            otp: generatedCode,
            method: loginOtpChoice,
          }),
        })
          .then((res) => res.json())
          .then((data) => {
            setDispatchedOtp(generatedCode);
            if (data.success) {
              if (data.simulated) {
                setOtpDispatchedMessage(`A verification code was simulated for ${destinationLabel}.`);
              } else {
                setOtpDispatchedMessage(`A secure OTP verification code has been dispatched directly to ${destinationLabel}. Check your inbox!`);
              }
            } else {
              setOtpDispatchedMessage(`Delivery Info: ${data.error || "Verification code triggered with delivery limits."}`);
            }
            setLoginSubStep(2);
            setLoginOtpInput("");
            setLoginLoading(false);
          })
          .catch((err) => {
            console.warn("Server API routing offline, falling back to secure sandbox token:", err);
            setDispatchedOtp(generatedCode);
            setOtpDispatchedMessage(`A secure verification code has been dispatched locally to ${destinationLabel} (Offline Sandbox Fallback).`);
            setLoginSubStep(2);
            setLoginOtpInput("");
            setLoginLoading(false);
          });
      }, 950);
    } else {
      // Validate OTP
      if (!loginOtpInput || loginOtpInput.trim().length !== 6) {
        setLoginError("Please provide the complete 6-digit verification code.");
        return;
      }

      setLoginLoading(true);
      setLoginError("");

      setTimeout(() => {
        if (loginOtpInput.trim() !== dispatchedOtp) {
          setLoginError("Invalid or expired OTP certification code. Please enter the correct code shown.");
          setLoginLoading(false);
          return;
        }

        if (!validatedUserObj) {
          setLoginError("Session trace lost. Please go back and authenticate gate credentials again.");
          setLoginSubStep(1);
          setLoginLoading(false);
          return;
        }

        // Success - Authenticate with user role from DB
        setLoginError("");
        setIsLoggedIn(true);
        setCurrentUserRole(validatedUserObj.role);
        setCurrentUserEmail(validatedUserObj.email);
        
        if (validatedUserObj.email.toLowerCase().trim() === "admin@peoplepulse.ap") {
          setCurrentTab("admin");
        } else {
          setCurrentTab("home");
        }
        
        // Clear session states
        setLoginSubStep(1);
        setLoginOtpInput("");
        setDispatchedOtp("");
        setOtpDispatchedMessage("");
        setLoginLoading(false);
      }, 950);
    }
  };

  const handleResendOtp = () => {
    if (!validatedUserObj || loginLoading) return;
    setLoginLoading(true);
    setLoginError("");

    const generatedCode = Math.floor(100000 + Math.random() * 900000).toString();
    const destinationLabel = loginOtpChoice === "email" ? validatedUserObj.email : validatedUserObj.phone;

    fetch("/api/send-otp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: validatedUserObj.email,
        phone: validatedUserObj.phone,
        otp: generatedCode,
        method: loginOtpChoice,
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        setDispatchedOtp(generatedCode);
        if (data.success) {
          if (data.simulated) {
            setOtpDispatchedMessage(`A new verification code was simulated for ${destinationLabel}.`);
          } else {
            setOtpDispatchedMessage(`A new secure OTP code has been successfully sent to ${destinationLabel}. Check your inbox!`);
          }
        } else {
          setOtpDispatchedMessage(`Delivery Info: ${data.error || "New OTP triggered with delivery limits."}`);
        }
        setLoginLoading(false);
      })
      .catch((err) => {
        console.warn("Server API routing offline, falling back to secure sandbox token:", err);
        setDispatchedOtp(generatedCode);
        setOtpDispatchedMessage(`New secure OTP code locally dispatched to ${destinationLabel} (Offline Sandbox Fallback).`);
        setLoginLoading(false);
      });
  };

  // Handle Signup Wizard Progressions
  const handleSignupNext = (e: FormEvent) => {
    e.preventDefault();
    if (signupStep === 1) {
      if (!signupName.trim() || !signupEmail.trim() || !signupPassword.trim()) {
        setSignupError("Please enter your name, email, and password.");
        return;
      }
      if (!signupEmail.includes("@")) {
        setSignupError("Please provide a valid workspace email address.");
        return;
      }
      if (checkUserExists(signupEmail)) {
        const validated = validateUser(signupEmail, signupPassword);
        if (validated) {
          // If the profile already exists and password matches, we prefill existing details and allow going forward
          setSignupError("");
          setSignupName(validated.name);
          setSignupPhone(validated.phone);
          setSignupDistrictId(validated.districtId);
          setSignupAffiliation(validated.affiliation);
          setSignupStep(3); // Skip straight to step 3 oath/affirmation
          return;
        } else {
          setSignupError("An observer profile with this email address has already been registered with a different password.");
          return;
        }
      } else {
        // Enforce password criteria
        if (!isPasswordValid(signupPassword)) {
          setSignupError("Password must be at least 6 characters long and contain at least one letter (a-z) and one number (0-9).");
          return;
        }
      }
      setSignupError("");
      setSignupStep(2);
    } else if (signupStep === 2) {
      setSignupError("");
      setSignupStep(3);
    }
  };

  const handleSignupPrev = () => {
    if (signupStep > 1) {
      setSignupError("");
      setSignupStep(prev => prev - 1);
    }
  };

  const handleSignupSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!signupOathChecked) {
      setSignupError("You must affirm and sign the Simulated Audit Oath to proceed.");
      return;
    }

    if (checkUserExists(signupEmail)) {
      const validated = validateUser(signupEmail, signupPassword);
      if (validated) {
        setSignupError("");
        setIsSigningUp(false);
        setSignupStep(1);
        setSignupSuccess(false);
        setLoginEmail(signupEmail);
        setLoginPassword("");
        setLoginSuccessMessage("This observer profile is already registered. Please sign in below.");
        return;
      } else {
        setSignupError("An observer profile with this email address has already been registered with a different password.");
        return;
      }
    }

    // Save the observer registration profile details into our database
    saveUser({
      name: signupName,
      email: signupEmail,
      password: signupPassword,
      phone: signupPhone || "+91 99999 99999", // Placeholder phone if none provided
      role: UserRole.FieldCoordinator, // Default observer role
      districtId: signupDistrictId,
      affiliation: signupAffiliation || "Independent Election Observer"
    });

    setSignupError("");

    // Directly proceed to the login page state
    setIsSigningUp(false);
    setSignupStep(1);
    setSignupSuccess(false);
    setLoginEmail(signupEmail);
    setLoginPassword("");
    setLoginSuccessMessage("Registration successful! Please verify your security database configuration by entering your password.");
  };

  const handleOnboardComplete = () => {
    // Authenticate matching newly-registered account
    const registeredUser = validateUser(signupEmail, signupPassword);
    
    setIsLoggedIn(true);
    setCurrentUserRole(registeredUser ? registeredUser.role : UserRole.FieldCoordinator);
    setCurrentUserEmail(registeredUser ? registeredUser.email : signupEmail);
    setRegisteredUsersCount(prev => prev + 1);
    
    if (registeredUser && registeredUser.email.toLowerCase().trim() === "admin@peoplepulse.ap") {
      setCurrentTab("admin");
    } else {
      setCurrentTab("home");
    }
    
    // Clean states so fresh login page is configured on logout
    setIsSigningUp(false);
    setSignupStep(1);
    setSignupSuccess(false);
    setLoginEmail(signupEmail);
  };

  // Handle Forgot/Reset Password requests for only observer users
  const handleForgotPasswordRequest = (e: FormEvent) => {
    e.preventDefault();
    if (forgotLoading) return;

    if (forgotStep === 1) {
      if (!forgotEmail) {
        setForgotError("Please enter your registered workspace email.");
        return;
      }

      setForgotLoading(true);
      setForgotError("");

      setTimeout(() => {
        const users = getAllUsers();
        const user = users.find((u) => u.email.toLowerCase() === forgotEmail.toLowerCase().trim());

        if (!user) {
          setForgotError("No profile has been registered under this email address.");
          setForgotLoading(false);
          return;
        }

        // Validate that this is ONLY an observer user (excluding SuperAdmin, StateAdministrator, and non-registered Citizens)
        const isObserver = [
          UserRole.FieldCoordinator,
          UserRole.DistrictCoordinator,
          UserRole.SurveyVolunteer,
          UserRole.ResearchAnalyst
        ].includes(user.role);

        if (!isObserver) {
          setForgotError("Self-service password reset is restricted to Field Observers, Volunteers, and Coordinators. Higher administrative roles must contact security operations for overrides.");
          setForgotLoading(false);
          return;
        }

        // Generate 6-digit Reset OTP code
        const generatedCode = Math.floor(100000 + Math.random() * 900000).toString();

        fetch("/api/send-otp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: user.email,
            phone: user.phone,
            otp: generatedCode,
            method: "email",
          }),
        })
          .then((res) => res.json())
          .then((data) => {
            setForgotOtp(generatedCode);
            if (data.success) {
              if (data.simulated) {
                setForgotSuccessMessage(`A password reset authorization code was simulated for ${user.email}.`);
              } else {
                setForgotSuccessMessage(`A confidential password reset verification code has been dispatched straight to ${user.email}.`);
              }
            } else {
              setForgotSuccessMessage(`Reset code triggered. (Sandbox simulated fallback active: ${data.error || "delivery limits"})`);
            }
            setForgotStep(2);
            setForgotLoading(false);
          })
          .catch((err) => {
            console.warn("Reset notification offline, falling back locally:", err);
            setForgotOtp(generatedCode);
            setForgotSuccessMessage(`A temporary password reset verification code was dispatched locally (Offline Fallback).`);
            setForgotStep(2);
            setForgotLoading(false);
          });
      }, 850);

    } else if (forgotStep === 2) {
      if (!forgotOtpInput || forgotOtpInput.trim().length !== 6) {
        setForgotError("Please enter the complete 6-digit password reset code.");
        return;
      }
      if (forgotOtpInput.trim() !== forgotOtp) {
        setForgotError("The password reset verification code entered is invalid or expired.");
        return;
      }
      if (!forgotNewPassword) {
        setForgotError("Please enter a new secure password.");
        return;
      }
      if (!isPasswordValid(forgotNewPassword)) {
        setForgotError("New Password must be at least 6 characters long and contain at least one letter (a-z) and one number (0-9).");
        return;
      }

      setForgotLoading(true);
      setForgotError("");

      setTimeout(() => {
        const success = updateUserPassword(forgotEmail, forgotNewPassword);
        if (success) {
          // Clear any locked attempts state on successful reset
          const emailKey = forgotEmail.toLowerCase().trim();
          localStorage.removeItem(`auth_lock_${emailKey}`);
          localStorage.removeItem(`auth_failed_${emailKey}`);

          // Sync credentials with the sign-in form inputs for painless login
          setLoginEmail(forgotEmail);
          setLoginPassword(forgotNewPassword);

          setForgotStep(3);
        } else {
          setForgotError("Could not database update. Please recheck the workspace state.");
        }
        setForgotLoading(false);
      }, 950);
    }
  };

  // Handle Contact submission
  const handleContactSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!contactName || !contactEmail || !contactMessage) {
      setContactFeedback("Please complete all required fields (*).");
      return;
    }
    setContactFeedback("SUCCESS");
    setTimeout(() => {
      setContactName("");
      setContactEmail("");
      setContactPhone("");
      setContactOrg("");
      setContactMessage("");
    }, 2000);
  };

  const filteredNews = newsFilter === "all" 
    ? NEWS_CARDS 
    : NEWS_CARDS.filter(n => n.category.toLowerCase() === newsFilter.toLowerCase());

  const filteredVideos = useMemo(() => {
    return videoFilter === "all"
      ? TRENDING_VIDEOS
      : TRENDING_VIDEOS.filter(v => v.category.toLowerCase() === videoFilter.toLowerCase());
  }, [videoFilter]);

  useEffect(() => {
    if (!autoplayNext || isAutoplayPaused || !activeVideo) {
      return;
    }

    const interval = setInterval(() => {
      setAutoplayCountdown((prev) => {
        if (prev <= 1) {
          const currentIndex = filteredVideos.findIndex(v => v.id === activeVideo.id);
          if (currentIndex !== -1) {
            const nextIndex = (currentIndex + 1) % filteredVideos.length;
            setActiveVideo(filteredVideos[nextIndex]);
          } else if (filteredVideos.length > 0) {
            setActiveVideo(filteredVideos[0]);
          }
          return 30;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [autoplayNext, isAutoplayPaused, activeVideo, filteredVideos]);

  useEffect(() => {
    setAutoplayCountdown(30);
  }, [activeVideo]);

  return (
    <div className={`min-h-screen flex flex-col justify-between font-sans selection:bg-black selection:text-[#F9F7F2] transition-colors duration-300 ${theme} ${
      theme === "dark" 
        ? "bg-[#0B0B0A] text-[#FAF8F5]" 
        : theme === "dark-beige"
        ? "bg-[#1E1C18] text-[#EADCC6]" 
        : theme === "earth-yellow"
        ? "bg-[#F4EBD0] text-[#3E2723]"
        : "bg-[#F9F7F2] text-[#121212]"
    }`}>
      
      {/* Dynamic Navbar */}
      <Navbar
        currentTab={currentTab}
        setCurrentTab={setCurrentTab}
        currentUserRole={currentUserRole}
        setCurrentUserRole={setCurrentUserRole}
        currentUserEmail={currentUserEmail}
        setCurrentUserEmail={setCurrentUserEmail}
        isLoggedIn={isLoggedIn}
        setIsLoggedIn={setIsLoggedIn}
        theme={theme}
        setTheme={setTheme}
      />

      {/* Main Container */}
      <main className="flex-grow max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10">

        {!isAP && ["analytics", "survey", "reports", "methodology", "media"].includes(currentTab) && (
          <div data-testid="ap-only-note" role="note" className="mb-6 border border-amber-700 bg-amber-100 text-amber-950 p-3 text-xs font-sans flex flex-wrap items-center gap-2">
            <DemoBadge testId="demo-badge-inline" />
            <span><strong>Andhra Pradesh only.</strong> {t("state.apOnly")}</span>
            <button type="button" onClick={() => setCurrentTab("elections")} className="underline font-bold cursor-pointer">{t("nav.elections")}</button>
          </div>
        )}

        {currentTab === "elections" && <ElectionsPage />}
        {currentTab === "civic" && <CivicHome />}

        {/* TAB 1: HOME SECTION */}
        {currentTab === "home" && (
          <div className="space-y-16">
            
             {/* Hero Section Banner */}
            <div id="hero-banner" className="bg-transparent text-black p-0 relative overflow-hidden border-y-2 border-black/80 py-10 sm:py-12">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch relative z-10">
                <div className="lg:col-span-7 space-y-6 flex flex-col justify-center">
                  <span className="text-[10px] bg-black text-[#F9F7F2] font-sans tracking-[0.3em] uppercase font-bold py-1.5 px-4.5 inline-block self-start">
                    STATEWIDE MONITOR ACTIVATED &bull; VOL. VI
                  </span>
                  
                  <h1 className="text-4xl sm:text-[76px] leading-[0.85] tracking-tighter italic font-serif font-normal text-black my-2">
                    The {isAP ? "Andhra" : "Telangana"} <br />
                    <span className="ml-0 sm:ml-12">Opinion</span>
                  </h1>

                  <p className="text-sm sm:text-base text-justify text-[#121212]/90 font-serif leading-relaxed max-w-2xl pt-1">
                    Exploring voter sentiment, public priorities, state governance feedback, and deep-lying electoral shifts across all {stateCfg.assemblySeats} Assembly Constituencies. Written with statistical precision and objective clarity.
                  </p>

                  <div className="flex flex-wrap gap-4 pt-4">
                    <button
                      onClick={() => setCurrentTab("survey")}
                      className="bg-black hover:bg-neutral-800 text-[#F9F7F2] font-sans text-[10px] tracking-[0.2em] uppercase font-bold py-3 px-8 border border-black transition-all cursor-pointer"
                    >
                      Take Survey
                    </button>
                    <button
                      onClick={() => setCurrentTab("analytics")}
                      className="bg-transparent hover:bg-black hover:text-[#F9F7F2] text-black font-sans text-[10px] tracking-[0.2em] uppercase font-bold py-3 px-8 border border-black transition-all cursor-pointer"
                    >
                      View Analytics Console
                    </button>
                  </div>
                </div>

                <div className="lg:col-span-5 h-[360px] lg:h-auto lg:min-h-[420px]" id="leaflet-hero-map-wrapper">
                  <HomeMap theme={theme} onSelectDistrict={(distId) => {
                    setSelectedDistrictId(distId);
                    setCurrentTab("analytics");
                    setTimeout(() => {
                      const element = document.getElementById("interactive-map-section");
                      if (element) {
                        element.scrollIntoView({ behavior: "smooth" });
                      }
                    }, 100);
                  }} />
                </div>
              </div>

              {/* Float map vector background accent */}
              <div className="absolute right-0 bottom-4 opacity-5 hidden lg:block transform scale-150 pointer-events-none">
                <Vote className="w-80 h-80 text-black" />
              </div>
            </div>

            {/* Hero Statistics counter display */}
            <div id="hero-statistics" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-6 relative">
              {[
                { count: String(stateCfg.assemblySeats), label: "Assembly Constituencies" },
                { count: isAP ? "26" : "33", label: "State Districts" },
                { count: isAP ? "680+" : "n/a", label: "Surveyed Mandals" },
                { count: isAP ? "13,000+" : "n/a", label: "Gram Panchayats" },
                { count: loggedPollsCount.toLocaleString() + "+", label: "Logged Polls", isPolls: true },
                { count: registeredUsersCount.toLocaleString() + "+", label: "Registered Users" },
                { count: "95%", label: "Statistical Confidence" }
              ].map((stat, idx) => (
                <div key={idx} className="bg-[#FAF8F5] p-6 border border-black/10 text-center hover:border-black/50 transition-colors duration-200 relative group min-h-[110px] flex flex-col justify-center">
                  <span className="text-2xl sm:text-3xl font-serif italic text-black block mb-1">{stat.count}</span>
                  <div className="h-[1px] w-8 bg-black/10 mx-auto my-2"></div>
                  <span className="text-[9px] text-[#121212]/80 block uppercase tracking-wider font-bold leading-snug">{stat.label}</span>
                  
                  {stat.isPolls && (
                    <div className="absolute inset-x-0 bottom-1 flex justify-center">
                      {!confirmResetPolls ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmResetPolls(true);
                          }}
                          className="opacity-0 group-hover:opacity-100 transition-opacity bg-neutral-900 text-white hover:bg-red-800 text-[8px] font-sans px-2 py-0.5 tracking-wider uppercase font-black border border-black cursor-pointer shadow-sm"
                          title="Click to initiate counters reset"
                        >
                          Reset Count
                        </button>
                      ) : (
                        <div className="flex items-center gap-1 bg-[#FAF8F5] px-1 border border-black/10 shadow-lg animate-fade-in">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setLoggedPollsCount(0);
                              setConfirmResetPolls(false);
                            }}
                            className="bg-red-700 text-white hover:bg-red-800 text-[7.5px] font-sans px-1.5 py-0.5 uppercase font-bold cursor-pointer"
                          >
                            Confirm?
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmResetPolls(false);
                            }}
                            className="bg-neutral-200 text-black hover:bg-neutral-300 text-[7.5px] font-sans px-1.5 py-0.5 uppercase font-bold cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Why People Pulse Section */}
            <div id="why-people-pulse" className="space-y-8">
              <div className="text-center space-y-2 border-b border-black/10 pb-6">
                <h2 className="text-2xl sm:text-3xl font-serif italic text-black">Why People Pulse?</h2>
                <p className="text-[10px] tracking-[0.2em] uppercase font-sans text-slate-500 max-w-lg mx-auto">
                  Bringing objectivity and statistical accountability to the state's democratic discussions.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                {[
                  { title: "Citizen Voice", desc: "Enabling everyday residents of Andhra Pradesh to file localized ratings on infrastructure, education quality, and welfare payouts directly." },
                  { title: "Public Issues Trackers", desc: "Aggregating regional grievance summaries into visual hot lists so policymakers can inspect which panchayats lack drinking water grids." },
                  { title: "Governance Feedback", desc: "Scientific polling indices assessing municipal administration, sitting MLAs' popularity, and government outreach speeds." },
                  { title: "Election Trends & Forecasts", desc: "Consolidated, unbiased voter intention models mapping current leaning margins in all key assembly strongholds." },
                  { title: "Development Indicators", desc: "Comprehensive scorecards focusing on tomato pricing, handloom weavers' welfare, or aquaculture power tariffs." },
                  { title: "Constituency Intelligence", desc: "Micro-level data portals compiling demographics, historic performance, and lead changes for researcher access." }
                ].map((card, idx) => (
                  <div key={idx} className="bg-[#FAF8F5] p-8 border border-black/10 flex flex-col justify-between hover:border-black transition-all">
                    <div>
                      <span className="text-[9px] text-[#121212] font-sans tracking-[0.25em] uppercase font-bold block mb-4 border-b border-black/10 pb-2">CURATION 0{idx + 1}</span>
                      <h4 className="text-base font-bold font-serif text-black mb-2.5">{card.title}</h4>
                      <p className="text-xs text-slate-650 leading-relaxed text-justify font-serif">{card.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Features Section */}
            <div id="platform-features" className="bg-[#E5E2D9]/20 p-8 sm:p-12 border border-black/10 space-y-8">
              <div className="flex flex-col md:flex-row md:items-end justify-between pb-6 border-b border-black/10">
                <div>
                  <span className="text-[9px] text-[#121212] font-sans tracking-widest uppercase font-black">METRIC CONSOLE</span>
                  <h3 className="text-xl sm:text-2xl font-serif italic text-black mt-1">Statewide Analytical Frameworks</h3>
                  <p className="text-xs text-slate-500 mt-1">Academic research methodologies and live public sentiment telemetry.</p>
                </div>
                <button
                  onClick={() => setCurrentTab("analytics")}
                  className="mt-4 md:mt-0 bg-black hover:bg-[#121212] text-[#F9F7F2] font-sans text-[10px] tracking-widest uppercase font-bold py-2.5 px-6 border border-black transition-all cursor-pointer"
                >
                  Inspect State Dashboard
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                {[
                  { title: "Constituency-Level Insights", desc: "Track public opinion in every constituency." },
                  { title: "District Analytics", desc: "Compare districts and regions." },
                  { title: "Trend Analysis", desc: "Monitor changing voter sentiment." },
                  { title: "Issue Tracking", desc: "Education, Health, Employment, Infrastructure." },
                  { title: "Leadership Ratings", desc: "Measure approval and satisfaction." },
                  { title: "Interactive Maps", desc: "Visualize survey responses geographically." },
                  { title: "Demographic Analysis", desc: "Age, Gender, Occupation, Education." },
                  { title: "Real-Time Dashboard", desc: "Live survey analytics." }
                ].map((feat, idx) => (
                  <div key={idx} className="bg-transparent border-l-2 border-black pl-4 py-1.5">
                    <strong className="text-xs text-black uppercase tracking-wider block font-bold">{feat.title}</strong>
                    <span className="text-[10.5px] text-slate-600 block mt-1 font-serif leading-relaxed">{feat.desc}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Testimonials */}
            <div id="testimonials" className="space-y-8">
              <h3 className="text-center text-[10px] font-sans uppercase tracking-[0.25em] text-[#121212] font-black">Perspectives on Governance & Integrity</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                {TESTIMONIALS.map((t) => (
                  <div key={t.id} className="bg-[#FAF8F5] p-8 border border-black/10 flex flex-col justify-between">
                    <p className="text-sm text-slate-800 italic font-serif leading-relaxed text-justify mb-6">
                      "{t.quote}"
                    </p>
                    <div className="border-t border-black/10 pt-4">
                      <strong className="text-[11px] text-black uppercase tracking-wider font-bold block">{t.author}</strong>
                      <span className="text-[9px] text-[#121212]/80 uppercase block tracking-wider mt-1">{t.role} / {t.location}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

          </div>
        )}

        {/* TAB 2: ANALYTICS DASHBOARD */}
        {currentTab === "analytics" && (
          <div className="space-y-8">
            
            <div className="bg-[#FAF8F5] text-black p-8 border-y border-black">
              <span className="text-[9px] uppercase tracking-[0.25em] font-sans font-black text-slate-500 block">Section 02 // Regional Analytics</span>
              <h2 className="text-2xl font-serif italic text-black mt-1">Andhra Pradesh Statewide Analytics Console <DemoBadge /></h2>
              <p className="text-xs text-slate-600 mt-2 max-w-2xl font-serif">
                Use the visual geographic representation to pick any of the 26 districts of Andhra Pradesh. The tables below compile current public approval and regional priorities on-the-fly.
              </p>
            </div>

            {/* Interactive geographic map handles filters state */}
            <InteractiveMap
              onSelectDistrict={handleSelectDistrict}
              selectedDistrictId={selectedDistrictId}
              surveyResponses={surveyResponses}
            />

            <MapLayers />

            {/* Statewide District Comparison Table */}
            <DistrictComparisonTable
              onSelectDistrict={handleSelectDistrict}
              selectedDistrictId={selectedDistrictId}
              surveyResponses={surveyResponses}
            />

            {/* Charts Widgets Container */}
            <DashboardWidgets
              selectedDistrict={selectedDistrict}
              surveyResponses={surveyResponses}
            />
            
          </div>
        )}

        {/* TAB 3: CONSTITUENCY PROFILER */}
        {currentTab === "constituencies" && (
          <div className="space-y-8">
            <ConstituencySearch year={defaultYear(stateCode, "assembly")} type="assembly" />
            {isAP ? (
              <ConstituencyPage
                registeredUsersCount={registeredUsersCount}
                loggedPollsCount={loggedPollsCount}
              />
            ) : (
              <div data-testid="ap-only-note" role="note" className="border border-amber-700 bg-amber-100 text-amber-950 p-3 text-xs font-sans">
                <strong>Andhra Pradesh only.</strong> {t("state.apOnly")}
              </div>
            )}
          </div>
        )}

        {/* TAB 4: SURVEY FORM */}
        {currentTab === "survey" && (
          <SurveyForm
            onSubmitResponse={handleAddResponse}
            selectedDistrictId={selectedDistrictId}
            onSelectDistrict={handleSelectDistrict}
          />
        )}

        {/* TAB 5: RESEARCH REPORTS */}
        {currentTab === "reports" && (
          <div className="space-y-8">
            <div className="border-b border-black/10 pb-4">
              <span className="text-[9px] uppercase tracking-[0.25em] font-sans font-black text-slate-500 block">Section 03 // Research Library</span>
              <h2 className="text-2xl font-serif italic text-black mt-1">Research & Scientific Reports</h2>
              <p className="text-xs text-slate-600 font-serif mt-1 max-w-2xl">
                Download complete, peer-reviewed opinion research studies prepared by statistical leads, social demographics cells, and agriculture advisors.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              {REPORTS.map((rep) => (
                <div key={rep.id} className="bg-[#FAF8F5] p-8 border border-black/15 flex flex-col justify-between space-y-4 hover:border-black transition-all">
                  <div>
                    <span className="text-[9px] bg-black text-[#F9F7F2] font-sans font-bold px-2.5 py-1 uppercase tracking-wider">{rep.category} focus</span>
                    <h4 className="text-lg font-serif italic text-slate-900 mt-4">{rep.title}</h4>
                    <span className="text-[10px] text-slate-400 font-mono block mt-1">Published: {rep.publishDate} &bull; By {rep.author}</span>
                    <p className="text-xs text-slate-700 mt-3 font-serif leading-relaxed text-justify">
                      {rep.summary}
                    </p>

                    <div className="mt-4 bg-transparent border-t border-dashed border-black/20 pt-4">
                      <strong className="text-[10px] text-[#121212] tracking-wider uppercase block mb-2 font-bold font-sans">Document Highlights</strong>
                      <ul className="list-disc list-inside text-xs text-slate-700 font-serif space-y-1.5 pl-1 text-justify">
                        {rep.highlights.map((h, id) => (
                          <li key={id}>{h}</li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-4 border-t border-black/10 text-xs font-mono">
                    <span className="text-slate-500">{rep.pdfSize} &bull; {rep.readTime}</span>
                    <button
                      onClick={() => alert(`Simulated Download of document: ${rep.title}`)}
                      className="bg-black hover:bg-neutral-800 text-[#F9F7F2] font-sans text-[10px] tracking-widest uppercase font-bold py-2 px-4 transition-colors cursor-pointer"
                    >
                      <span>Download PDF</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 6: SURVEY METHODOLOGY */}
        {currentTab === "methodology" && (
          <div className="space-y-8 bg-[#FAF8F5] p-8 sm:p-12 border border-black/15 font-serif">
            
            <div className="border-b border-black pb-4">
              <h2 className="text-2xl font-serif italic text-black flex items-center space-x-2">
                <BookOpen className="w-5 h-5 text-black" />
                <span>Scientific Survey Methodology</span>
              </h2>
              <p className="text-xs text-slate-500 font-sans tracking-wide mt-1 max-w-2xl opacity-80">
                People Pulse follows rigorous statistical methods to ensure representative and reliable public opinion measurement.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-10 text-xs leading-relaxed">
              
              <div className="space-y-4">
                <h4 className="text-sm font-sans uppercase tracking-widest font-black text-black border-b border-black/10 pb-1">Sampling Strategy</h4>
                
                <div className="space-y-4">
                  <div>
                    <strong className="text-black uppercase tracking-widest text-[9.5px] font-sans block font-bold">Random Sampling</strong>
                    <p className="text-slate-750 mt-0.5 leading-relaxed text-justify">Voter segments in all 26 districts are chosen programmatically using localized random-walk household surveys across mandals and census corridors.</p>
                  </div>
                  <div>
                    <strong className="text-black uppercase tracking-widest text-[9.5px] font-sans block font-bold">Stratified Sampling</strong>
                    <p className="text-slate-750 mt-0.5 leading-relaxed text-justify">Targets fixed demographic strata matching Census 2011 gender, caste representation ratios, and regional density indicators.</p>
                  </div>
                  <div>
                    <strong className="text-black uppercase tracking-widest text-[9.5px] font-sans block font-bold">Demographic Balancing</strong>
                    <p className="text-slate-750 mt-0.5 leading-relaxed text-justify">Calculations employ sample weights (raking method) to offset minor self-selection bias during digital poll inputs.</p>
                  </div>
                  <div>
                    <strong className="text-black uppercase tracking-widest text-[9.5px] font-sans block font-bold">Constituency Representation</strong>
                    <p className="text-slate-750 mt-0.5 leading-relaxed text-justify">We maintain minimum sample sizes of 250 respondents per AC for each of the 175 assembly constituencies.</p>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <h4 className="text-sm font-sans uppercase tracking-widest font-black text-black border-b border-black/10 pb-1">Integrity & Quality Gates</h4>

                <div className="space-y-4">
                  <div>
                    <strong className="text-black uppercase tracking-widest text-[9.5px] font-sans block font-bold">Quality Validation</strong>
                    <p className="text-slate-750 mt-0.5 leading-relaxed text-justify">A minimum of 10% of field volunteer surveys are cross-audited over phone verification recalls by regional coordinators.</p>
                  </div>
                  <div>
                    <strong className="text-black uppercase tracking-widest text-[9.5px] font-sans block font-bold">Duplicate Detection</strong>
                    <p className="text-slate-750 mt-0.5 leading-relaxed text-justify">We automatically cross-reference mobile phone identifiers and block sequential entries originating from matching devices.</p>
                  </div>
                  <div>
                    <strong className="text-black uppercase tracking-widest text-[9.5px] font-sans block font-bold">Confidence Intervals</strong>
                    <p className="text-slate-750 mt-0.5 leading-relaxed text-justify">Our statewide analytics dashboards carry an absolute confidence margin of 95% and error margins of ±1.8%.</p>
                  </div>
                  <div>
                    <strong className="text-black uppercase tracking-widest text-[9.5px] font-sans block font-bold">Data Verification</strong>
                    <p className="text-slate-750 mt-0.5 leading-relaxed text-justify">All incoming digital records pass secondary automated validation loops for geographic consistency and logical consistency.</p>
                  </div>
                </div>
              </div>

            </div>

          </div>
        )}

        {/* TAB 7: MEDIA CENTER */}
        {currentTab === "media" && (
          <div className="space-y-12">
            
            {/* Header section */}
            <div className="pb-4 border-b border-black/20">
              <span className="text-[9px] uppercase tracking-[0.25em] font-sans font-black text-slate-500 block">Section 04 // Press & Broadcast Registers</span>
              <h2 className="text-3xl font-serif italic text-[#121212] flex items-center space-x-2 mt-1">
                <Newspaper className="w-6 h-6 text-black animate-pulse" />
                <span>Media Center & Broadcast Hub</span>
              </h2>
              <p className="text-xs text-slate-500 mt-1 font-serif">Watch trending video reports, debates, and read weekly governance insights compiled by major media channels.</p>
            </div>

            {/* SECTION 1: TRENDING VIDEOS THEATER */}
            <div className="space-y-6 bg-black/5 p-6 border border-black/15">
              <div className="flex flex-col md:flex-row md:items-center justify-between pb-4 border-b border-black/10 gap-4">
                <div>
                  <span className="text-[8px] uppercase tracking-widest font-sans font-black text-amber-700 bg-amber-500/10 px-2 py-0.5 rounded-none">Active Broadcast</span>
                  <h3 className="text-lg font-serif italic text-black font-bold mt-1.5 flex items-center space-x-2">
                    <Tv className="w-4 h-4 text-black" />
                    <span>Trending Videos & Debates</span>
                  </h3>
                </div>

                {/* Video Category Filter pills */}
                <div className="flex flex-wrap gap-1 bg-white p-1 border border-black/10 text-[9.5px] font-sans">
                  {["all", "debate", "analysis", "assembly", "development", "press meet"].map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setVideoFilter(cat)}
                      className={`px-2.5 py-1 transition capitalize font-bold ${
                        videoFilter === cat ? "bg-black text-[#F9F7F2]" : "text-slate-600 hover:text-black hover:bg-black/5"
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              {/* Theater layout */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                
                {/* Main Video Player Container */}
                <div className="lg:col-span-8 flex flex-col justify-between space-y-4">
                  {activeVideo ? (
                    <div className="space-y-4">
                      {/* Player Source Selector Tab */}
                      <div className="flex bg-[#FAF8F5] border border-black/15 overflow-hidden">
                        <button
                          type="button"
                          id="player-mode-native"
                          onClick={() => setPlayerMode("hd-native")}
                          className={`flex-1 py-2.5 px-4 text-center font-sans text-[10px] tracking-wider font-bold uppercase transition flex items-center justify-center space-x-2 border-r border-black/10 cursor-pointer ${
                            playerMode === "hd-native"
                              ? "bg-black text-[#F9F7F2]"
                              : "text-slate-600 hover:text-black hover:bg-black/5"
                          }`}
                        >
                          <Play className="w-3.5 h-3.5 fill-current" />
                          <span>HD Broadcast Stream (100% Playable)</span>
                        </button>
                        <button
                          type="button"
                          id="player-mode-youtube"
                          onClick={() => setPlayerMode("youtube")}
                          className={`flex-1 py-2.5 px-4 text-center font-sans text-[10px] tracking-wider font-bold uppercase transition flex items-center justify-center space-x-2 cursor-pointer ${
                            playerMode === "youtube"
                              ? "bg-black text-[#F9F7F2]"
                              : "text-slate-600 hover:text-black hover:bg-black/5"
                          }`}
                        >
                          <Tv className="w-3.5 h-3.5" />
                          <span>YouTube Official Feed (Alternative)</span>
                        </button>
                      </div>

                      {/* Responsive Video Frame */}
                      <div className="relative aspect-video bg-black shadow-lg border border-black/20 overflow-hidden group">
                        {playerMode === "hd-native" && activeVideo.videoUrl ? (
                          <video
                            key={activeVideo.id}
                            src={activeVideo.videoUrl}
                            poster={activeVideo.thumbnailUrl}
                            controls
                            autoPlay
                            muted
                            className="absolute inset-0 w-full h-full object-cover"
                          />
                        ) : (
                          <div className="absolute inset-0 bg-slate-950 flex flex-col justify-between p-6 text-[#F9F7F2] font-sans">
                            {/* Visual background image thumbnail with absolute dark overlay */}
                            {activeVideo.thumbnailUrl && (
                              <img
                                src={activeVideo.thumbnailUrl}
                                alt={activeVideo.title}
                                referrerPolicy="no-referrer"
                                className="absolute inset-0 w-full h-full object-cover opacity-20 pointer-events-none"
                              />
                            )}
                            
                            <div className="relative z-10 flex justify-between items-start">
                              <span className="text-[9px] uppercase tracking-[0.25em] font-sans font-black text-amber-500 bg-amber-500/10 px-2 py-1 border border-amber-500/20">
                                Sandboxed Iframe Fallback
                              </span>
                              <span className="text-[8px] font-mono text-slate-400">
                                ID: {activeVideo.youtubeId}
                              </span>
                            </div>

                            <div className="relative z-10 max-w-lg space-y-2.5 my-auto">
                              <h4 className="text-base md:text-lg font-serif italic font-black text-white leading-snug">
                                {activeVideo.title}
                              </h4>
                              <p className="text-[11px] text-slate-300 leading-relaxed font-serif">
                                YouTube restricts players from playing inside sandboxed app previews or specific secure frames. You can open this broadcast directly on YouTube, or instantly switch to our fully-playable "HD Broadcast Stream" built-in player.
                              </p>
                              
                              <div className="flex flex-wrap gap-2.5 pt-1">
                                <a
                                  href={`https://www.youtube.com/watch?v=${activeVideo.youtubeId}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="bg-[#FF0000] hover:bg-[#CC0000] text-white text-[9px] font-bold uppercase tracking-widest py-2 px-3.5 flex items-center space-x-1.5 transition shadow-lg shadow-red-600/10"
                                >
                                  <span>Open on YouTube ↗</span>
                                </a>
                                <button
                                  type="button"
                                  onClick={() => setPlayerMode("hd-native")}
                                  className="bg-white hover:bg-slate-100 text-black text-[9px] font-bold uppercase tracking-widest py-2 px-3.5 transition"
                                >
                                  <span>Play HD Broadcast Stream</span>
                                </button>
                              </div>
                            </div>

                            <div className="relative z-10 border-t border-white/10 pt-2 flex justify-between text-[8px] font-mono text-slate-400">
                              <span>Broadcaster: {activeVideo.channel}</span>
                              <span>Duration: {activeVideo.duration} mins</span>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Video description card */}
                      <div className="bg-white p-5 border border-black/10 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/5 pb-2">
                          <div className="flex items-center space-x-2">
                            <span className="bg-red-750 text-white font-sans text-[8.5px] font-black uppercase tracking-widest px-2 py-0.5 rounded-none">
                              {activeVideo.category}
                            </span>
                            <span className="text-black font-serif italic font-bold text-xs">
                              via {activeVideo.channel}
                            </span>
                          </div>
                          <span className="text-[9px] text-slate-400 font-mono">{activeVideo.publishDate} &bull; {activeVideo.duration} mins</span>
                        </div>

                        <h4 className="text-lg font-serif italic font-black text-black leading-snug">{activeVideo.title}</h4>
                        <p className="text-xs text-slate-700 leading-relaxed font-serif text-justify">
                          {activeVideo.description}
                        </p>

                        {/* Reaction Button Group */}
                        <div className="pt-4 border-t border-black/10 flex flex-wrap items-center justify-between gap-3">
                          <div className="flex items-center space-x-2">
                            {/* Like Button */}
                            <button
                              type="button"
                              id={`video-like-${activeVideo.id}`}
                              onClick={() => handleVideoReaction(activeVideo.id, "like")}
                              className={`flex items-center space-x-1.5 px-3 py-1.5 border text-xs font-sans font-bold transition duration-150 cursor-pointer ${
                                videoReactions[activeVideo.id]?.liked
                                  ? "bg-black text-[#F9F7F2] border-black"
                                  : "bg-white text-slate-700 border-black/10 hover:border-black/30 hover:bg-slate-50"
                              }`}
                            >
                              <ThumbsUp className={`w-3.5 h-3.5 ${videoReactions[activeVideo.id]?.liked ? "fill-white text-white" : ""}`} />
                              <span>{videoReactions[activeVideo.id]?.likesCount ?? 0}</span>
                            </button>

                            {/* Dislike Button */}
                            <button
                              type="button"
                              id={`video-dislike-${activeVideo.id}`}
                              onClick={() => handleVideoReaction(activeVideo.id, "dislike")}
                              className={`flex items-center space-x-1.5 px-3 py-1.5 border text-xs font-sans font-bold transition duration-150 cursor-pointer ${
                                videoReactions[activeVideo.id]?.disliked
                                  ? "bg-black text-[#F9F7F2] border-black"
                                  : "bg-white text-slate-700 border-black/10 hover:border-black/30 hover:bg-slate-50"
                              }`}
                            >
                              <ThumbsDown className={`w-3.5 h-3.5 ${videoReactions[activeVideo.id]?.disliked ? "fill-white text-white" : ""}`} />
                              <span>{videoReactions[activeVideo.id]?.dislikesCount ?? 0}</span>
                            </button>

                            {/* Bookmark Button */}
                            <button
                              type="button"
                              id={`video-bookmark-${activeVideo.id}`}
                              onClick={() => handleVideoReaction(activeVideo.id, "bookmark")}
                              className={`flex items-center space-x-1.5 px-3 py-1.5 border text-xs font-sans font-bold transition duration-150 cursor-pointer ${
                                videoReactions[activeVideo.id]?.bookmarked
                                  ? "bg-amber-700 text-[#F9F7F2] border-amber-700"
                                  : "bg-white text-slate-700 border-black/10 hover:border-black/30 hover:bg-slate-50"
                              }`}
                            >
                              <Bookmark className={`w-3.5 h-3.5 ${videoReactions[activeVideo.id]?.bookmarked ? "fill-white text-white" : ""}`} />
                              <span>{videoReactions[activeVideo.id]?.bookmarked ? "Saved" : "Save"}</span>
                            </button>
                          </div>

                          <a
                            href={`https://www.youtube.com/watch?v=${activeVideo.youtubeId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="bg-[#121212] hover:bg-black text-white text-[9px] font-sans font-bold uppercase tracking-widest py-2 px-3 flex items-center space-x-1.5 transition"
                          >
                            <span>Open in YouTube ↗</span>
                          </a>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="aspect-video bg-slate-900 flex flex-col items-center justify-center text-center p-8 text-white space-y-3">
                      <Tv className="w-12 h-12 text-slate-600 animate-pulse" />
                      <p className="font-serif italic text-sm">Please select a video from the broadcast playlist.</p>
                    </div>
                  )}
                </div>

                {/* Sidebar Playlist */}
                <div className="lg:col-span-4 flex flex-col bg-white border border-black/10 h-[520px] overflow-hidden">
                  <div className="p-4 bg-[#FAF8F5] border-b border-black/10 flex justify-between items-center shrink-0">
                    <span className="text-[9px] text-slate-550 font-sans font-black uppercase tracking-widest">Broadcast Playlist</span>
                    <span className="text-[9px] font-mono bg-black text-white px-2 py-0.5 font-bold uppercase">
                      {filteredVideos.length} Available
                    </span>
                  </div>

                  {/* Autoplay Control Panel */}
                  <div className="px-4 py-2.5 bg-[#F4F1EA] border-b border-black/15 flex items-center justify-between shrink-0">
                    <label className="inline-flex items-center gap-2.5 cursor-pointer select-none">
                      <div className="relative">
                        <input 
                          type="checkbox" 
                          id="autoplay-toggle-checkbox"
                          checked={autoplayNext} 
                          onChange={(e) => setAutoplayNext(e.target.checked)} 
                          className="sr-only peer"
                        />
                        <div className="w-7 h-4 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-amber-700"></div>
                      </div>
                      <span className="text-[9px] font-sans font-black uppercase tracking-widest text-slate-800">Auto-play Next</span>
                    </label>

                    {autoplayNext && (
                      <div className="flex items-center space-x-2 text-[9px] font-mono text-slate-600">
                        <span className="relative flex h-1.5 w-1.5">
                          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75 ${isAutoplayPaused ? "hidden" : ""}`}></span>
                          <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${isAutoplayPaused ? "bg-slate-400" : "bg-amber-600"}`}></span>
                        </span>
                        <span>
                          {isAutoplayPaused ? "Paused" : `Next in ${autoplayCountdown}s`}
                        </span>
                        <button
                          type="button"
                          id="autoplay-pause-toggle"
                          onClick={() => setIsAutoplayPaused(!isAutoplayPaused)}
                          className="ml-1 px-1.5 py-0.5 border border-black/10 hover:border-black bg-white hover:bg-slate-50 font-sans text-[8px] font-black uppercase tracking-wider transition cursor-pointer"
                        >
                          {isAutoplayPaused ? "Resume" : "Pause"}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="overflow-y-auto divide-y divide-black/10 flex-1 scrollbar-thin">
                    {filteredVideos.length > 0 ? (
                      filteredVideos.map((video) => {
                        const isPlaying = activeVideo?.id === video.id;
                        return (
                          <button
                            key={video.id}
                            type="button"
                            onClick={() => setActiveVideo(video)}
                            className={`w-full text-left p-4 hover:bg-slate-50 transition flex items-start space-x-3.5 cursor-pointer ${
                              isPlaying ? "bg-amber-500/10 border-l-4 border-amber-600" : ""
                            }`}
                          >
                            {/* Dummy Thumbnail with Play overlay */}
                            <div className="relative w-28 aspect-video bg-slate-950 border border-black/10 shrink-0 flex items-center justify-center overflow-hidden">
                              <img
                                src={`https://img.youtube.com/vi/${video.youtubeId}/hqdefault.jpg`}
                                alt={video.title}
                                referrerPolicy="no-referrer"
                                className="absolute inset-0 w-full h-full object-cover opacity-80"
                                onError={(e) => {
                                  // Fallback if YouTube image isn't reachable
                                  e.currentTarget.style.display = "none";
                                }}
                              />
                              <div className="absolute inset-0 bg-black/40 flex items-center justify-center group-hover:bg-black/20 transition">
                                <Play className={`w-5 h-5 ${isPlaying ? "text-amber-600 animate-pulse" : "text-white"}`} fill="currentColor" />
                              </div>
                              <span className="absolute bottom-1 right-1 bg-black/85 text-[8px] text-white font-mono px-1 font-bold">
                                {video.duration}
                              </span>
                            </div>

                            {/* Info */}
                            <div className="space-y-1 overflow-hidden">
                              <span className="text-[8px] text-slate-400 font-mono block font-bold uppercase tracking-wider">
                                {video.channel}
                              </span>
                              <h5 className="text-[11.5px] font-serif font-black text-black leading-tight line-clamp-2">
                                {video.title}
                              </h5>
                              <span className="text-[8.5px] uppercase font-sans font-black text-amber-700 tracking-wider inline-block">
                                {video.category}
                              </span>
                            </div>
                          </button>
                        );
                      })
                    ) : (
                      <div className="p-8 text-center space-y-2">
                        <Tv className="w-8 h-8 text-slate-300 mx-auto" />
                        <span className="font-sans font-black uppercase text-[9px] text-slate-400 block">No Videos Found</span>
                        <button
                          type="button"
                          onClick={() => setVideoFilter("all")}
                          className="text-[9px] font-sans font-bold uppercase tracking-widest text-red-750 hover:underline cursor-pointer"
                        >
                          Clear Filters
                        </button>
                      </div>
                    )}
                  </div>
                </div>

              </div>
            </div>

            {/* SECTION 2: PRESS ARTICLES AND INSIGHTS */}
            <div className="space-y-6">
              <div className="flex flex-col md:flex-row md:items-end justify-between pb-4 border-b border-black/15 gap-4">
                <div>
                  <span className="text-[8px] uppercase tracking-widest font-sans font-black text-slate-500 bg-slate-100 px-2 py-0.5 rounded-none">Analytical Coverage</span>
                  <h3 className="text-lg font-serif italic text-black font-bold mt-1.5 flex items-center space-x-2">
                    <Newspaper className="w-4 h-4 text-black" />
                    <span>In-depth News & Field Reports</span>
                  </h3>
                  <p className="text-[11px] text-slate-500 mt-0.5 font-serif">Read certified logs, press releases, and infrastructure assessments.</p>
                </div>

                {/* Filter pills for news */}
                <div className="flex flex-wrap gap-1 bg-[#E5E2D9]/30 p-1 border border-black/10 text-[9.5px] font-sans">
                  {["all", "sentiment", "trends", "development", "highlights", "election watch", "governance"].map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setNewsFilter(cat)}
                      className={`px-2.5 py-1 transition capitalize font-bold ${
                        newsFilter === cat ? "bg-black text-[#F9F7F2]" : "text-slate-600 hover:text-black hover:bg-black/5"
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              {/* News Grid */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                {filteredNews.map((news) => (
                  <div key={news.id} className="bg-[#FAF8F5] p-6 border border-black/15 flex flex-col justify-between hover:border-black transition-all">
                    <div className="space-y-3">
                      <div className="flex justify-between items-center border-b border-black/5 pb-1.5">
                        <span className="text-[8.5px] uppercase font-sans tracking-[0.25em] font-black text-amber-700">{news.category} update</span>
                        {news.source && (
                          <span className="bg-black text-[#F9F7F2] px-1.5 py-0.5 font-mono text-[8px] tracking-wide uppercase font-bold">
                            {news.source}
                          </span>
                        )}
                      </div>
                      <h4 className="text-base font-serif italic font-bold text-slate-900 leading-snug">{news.title}</h4>
                      <span className="text-[9px] text-slate-400 font-mono block">{news.date}</span>
                      <p className="text-xs text-slate-700 leading-relaxed font-serif text-justify pt-1">
                        {news.summary}
                      </p>
                    </div>
                    <div className="pt-4 border-t border-black/5 text-[10px] font-sans uppercase tracking-widest text-[#121212]/70 mt-6 flex justify-between items-center">
                      <span>{news.readTime}</span>
                      {news.sourceUrl && news.sourceUrl !== "#" ? (
                        <a 
                          href={news.sourceUrl} 
                          target="_blank" 
                          rel="noopener noreferrer" 
                          className="text-black font-black hover:underline cursor-pointer flex items-center space-x-1"
                        >
                          <span>Visit Source ↗</span>
                        </a>
                      ) : (
                        <span className="text-black font-black hover:underline cursor-pointer">Read Full Story &bull;</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

          </div>
        )}

        {/* TAB 7.5: FAQ SECTION */}
        {currentTab === "faq" && (
          <FAQPage />
        )}

        {/* TAB 8: CONTACT US */}
        {currentTab === "contact" && (
          <div className="max-w-3xl mx-auto bg-[#FAF8F5] p-8 sm:p-12 border border-black/15 space-y-8 font-serif">
            
            <div className="text-center space-y-1">
              <span className="text-[9px] uppercase tracking-[0.25em] font-sans font-black text-slate-500 block">Section 05 // Inquiries</span>
              <h2 className="text-2xl font-serif italic text-black">Contact Our Research Cell</h2>
              <p className="text-xs text-slate-500 font-sans tracking-wide max-w-sm mx-auto opacity-85">
                Have inquiries about statistical data, sample blocks, or volunteer participation? Reach out using the channel below.
              </p>
            </div>

            {contactFeedback === "SUCCESS" ? (
              <div className="border border-black bg-black text-[#F9F7F2] p-6 text-center text-xs font-mono">
                ✓ Message received successfully! Our coordination cell will address your inquiry within 48 business hours.
              </div>
            ) : (
              <form onSubmit={handleContactSubmit} className="space-y-5 text-xs font-sans">
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-[10px] tracking-wider uppercase font-bold text-slate-600 mb-1">Full Name *</label>
                    <input
                      type="text"
                      required
                      value={contactName}
                      onChange={(e) => setContactName(e.target.value)}
                      placeholder="e.g. Dr. Prasad Naidu"
                      className="w-full bg-[#F9F7F2] border border-black/15 focus:border-black p-3 rounded-none focus:outline-none text-xs font-serif"
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] tracking-wider uppercase font-bold text-slate-600 mb-1">Official Email Address *</label>
                    <input
                      type="email"
                      required
                      value={contactEmail}
                      onChange={(e) => setContactEmail(e.target.value)}
                      placeholder="e.g. prasad@research.org"
                      className="w-full bg-[#F9F7F2] border border-black/15 focus:border-black p-3 rounded-none focus:outline-none text-xs font-serif"
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] tracking-wider uppercase font-bold text-slate-600 mb-1">Phone Number (Omissible)</label>
                    <input
                      type="tel"
                      value={contactPhone}
                      onChange={(e) => setContactPhone(e.target.value)}
                      placeholder="e.g. 98480 91192"
                      className="w-full bg-[#F9F7F2] border border-black/15 focus:border-black p-3 rounded-none focus:outline-none text-xs font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] tracking-wider uppercase font-bold text-slate-600 mb-1">Organization / Affiliation</label>
                    <input
                      type="text"
                      value={contactOrg}
                      onChange={(e) => setContactOrg(e.target.value)}
                      placeholder="e.g. Andhra University Research Cell"
                      className="w-full bg-[#F9F7F2] border border-black/15 focus:border-black p-3 rounded-none focus:outline-none text-xs font-serif"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] tracking-wider uppercase font-bold text-slate-600 mb-1">Inquiry Message *</label>
                  <textarea
                    required
                    value={contactMessage}
                    onChange={(e) => setContactMessage(e.target.value)}
                    placeholder="Brief details about your regional queries..."
                    rows={4}
                    className="w-full bg-[#F9F7F2] border border-black/15 focus:border-black p-3 rounded-none focus:outline-none text-xs font-serif"
                  ></textarea>
                </div>

                {contactFeedback && contactFeedback !== "SUCCESS" && (
                  <div className="text-red-700 font-bold font-mono">{contactFeedback}</div>
                )}

                <div className="pt-2">
                  <button
                    type="submit"
                    className="w-full bg-black hover:bg-neutral-800 text-[#F9F7F2] font-sans text-[10px] tracking-widest uppercase font-black py-3 border border-black transition-all cursor-pointer"
                  >
                    <span>Submit Formal Inquiry</span>
                  </button>
                </div>

              </form>
            )}

          </div>
        )}

        {/* TAB 9: SIGN IN SPLASH GATEWAY OR 3-STEP SIGN-UP WORKSPACE */}
        {currentTab === "login" && (
          <div className="max-w-md mx-auto bg-[#FAF8F5] p-8 sm:p-10 border border-black/15 space-y-6">
            {isForgotMode ? (
              <div className="space-y-6">
                <div className="text-center">
                  <span className="text-[40px] block mb-2 leading-none">🔑</span>
                  <h2 className="text-xl font-serif italic text-black">Reset Observer Password</h2>
                  <p className="text-[10px] font-sans tracking-wide text-gray-500 mt-1 uppercase max-w-[320px] mx-auto leading-relaxed">
                    Self-service security credential reset for registered election observers.
                  </p>
                </div>

                {forgotStep === 1 && (
                  <form onSubmit={handleForgotPasswordRequest} className="space-y-4 text-xs font-serif">
                    <div>
                      <label className="block text-[10px] font-sans uppercase tracking-wider text-slate-600 mb-1">Registered Observer Email</label>
                      <input
                        type="email"
                        required
                        disabled={forgotLoading}
                        value={forgotEmail}
                        onChange={(e) => setForgotEmail(e.target.value)}
                        placeholder="e.g. Haritha@observer.ap.gov.in"
                        className="w-full bg-[#F9F7F2] border border-black/15 focus:border-black p-3 focus:outline-none text-xs font-mono rounded-none text-black disabled:opacity-60"
                      />
                    </div>

                    {forgotError && (
                      <span className="text-[10px] text-red-700 font-semibold font-mono block leading-relaxed">{forgotError}</span>
                    )}

                    <div className="pt-2 flex flex-col gap-2">
                      <button
                        type="submit"
                        disabled={forgotLoading}
                        className="w-full bg-black hover:bg-neutral-800 disabled:bg-neutral-400 text-[#F9F7F2] font-sans text-[10px] tracking-widest uppercase font-black py-3 border border-black transition-all cursor-pointer flex items-center justify-center space-x-2"
                      >
                        {forgotLoading ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            <span>Checking profile...</span>
                          </>
                        ) : (
                          <span>Send Reset OTP Code</span>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setIsForgotMode(false);
                          setLoginError("");
                        }}
                        className="w-full bg-transparent hover:bg-neutral-50 text-black font-sans text-[10px] tracking-widest uppercase font-bold py-2.5 border border-black/15 transition-all text-center cursor-pointer"
                      >
                        Back to Sign In
                      </button>
                    </div>
                  </form>
                )}

                {forgotStep === 2 && (
                  <form onSubmit={handleForgotPasswordRequest} className="space-y-4 text-xs font-serif">
                    <div className="bg-emerald-50 border border-emerald-500/20 p-3 text-[10.5px] text-emerald-800 leading-snug">
                      {forgotSuccessMessage}
                    </div>

                    {/* Simulation bypass indicator for observers */}
                    {forgotOtp && (
                      <div className="bg-[#FAF8F5] border border-red-800/20 p-3 text-center rounded-none shadow-sm space-y-1">
                        <span className="text-[8px] bg-red-800 text-white px-2 py-0.5 tracking-widest font-sans font-bold uppercase">
                          Sandbox Decrypted Bypass
                        </span>
                        <div className="text-[10px] font-sans tracking-wide text-red-950 font-bold">
                          Password Reset Code:
                        </div>
                        <div className="text-xl font-mono tracking-[0.25em] font-black text-black bg-red-50/50 py-1 border border-red-200 select-all">
                          {forgotOtp}
                        </div>
                      </div>
                    )}

                    <div>
                      <label className="block text-[10px] font-sans uppercase tracking-wider text-slate-600 mb-1">Verify 6-Digit Password Reset Code</label>
                      <input
                        type="text"
                        required
                        maxLength={6}
                        disabled={forgotLoading}
                        value={forgotOtpInput}
                        onChange={(e) => setForgotOtpInput(e.target.value.replace(/\D/g, ""))}
                        placeholder="e.g. 123456"
                        className="w-full bg-[#F9F7F2] border border-black/15 focus:border-black p-3 text-center focus:outline-none text-xs font-mono tracking-[0.4em] font-black rounded-none text-black disabled:opacity-60"
                      />
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="block text-[10px] font-sans uppercase tracking-wider text-slate-600">New Password</label>
                        <div className="relative group inline-block">
                          <span className="cursor-help text-[9px] bg-slate-100 hover:bg-slate-200 text-slate-500 rounded-full w-3.5 h-3.5 inline-flex items-center justify-center font-bold">?</span>
                          <div className="absolute right-0 bottom-full mb-1.5 hidden group-hover:block w-48 bg-black text-white text-[9.5px] p-2.5 font-sans font-normal normal-case rounded shadow-lg z-50 leading-relaxed text-left">
                            <strong className="font-semibold text-red-400">Password Criteria:</strong>
                            <ul className="list-disc pl-3 mt-1 space-y-0.5 text-slate-300">
                              <li>At least 6 characters</li>
                              <li>At least one letter (a-z / A-Z)</li>
                              <li>At least one number (0-9)</li>
                            </ul>
                            <div className="absolute top-full right-1 border-4 border-transparent border-t-black"></div>
                          </div>
                        </div>
                      </div>
                      <div className="relative">
                        <input
                          type={showForgotNewPassword ? "text" : "password"}
                          required
                          disabled={forgotLoading}
                          value={forgotNewPassword}
                          onChange={(e) => setForgotNewPassword(e.target.value)}
                          placeholder="Min 6 chars (letter & digit)"
                          className="w-full bg-[#F9F7F2] border border-black/15 focus:border-black p-3 pr-10 focus:outline-none text-xs rounded-none text-black font-mono disabled:opacity-60"
                        />
                        <button
                          type="button"
                          onClick={() => setShowForgotNewPassword(!showForgotNewPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-black focus:outline-none cursor-pointer"
                          title={showForgotNewPassword ? "Hide password" : "Show password"}
                        >
                          {showForgotNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    {forgotError && (
                      <span className="text-[10px] text-red-700 font-semibold font-mono block leading-relaxed">{forgotError}</span>
                    )}

                    <div className="pt-2 flex flex-col gap-2">
                      <button
                        type="submit"
                        disabled={forgotLoading}
                        className="w-full bg-black hover:bg-neutral-800 disabled:bg-neutral-400 text-[#F9F7F2] font-sans text-[10px] tracking-widest uppercase font-black py-3 border border-black transition-all cursor-pointer flex items-center justify-center space-x-2"
                      >
                        {forgotLoading ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            <span>Updating password...</span>
                          </>
                        ) : (
                          <span>Update Password</span>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setForgotStep(1);
                          setForgotError("");
                          setForgotOtp("");
                          setForgotOtpInput("");
                          setForgotNewPassword("");
                        }}
                        className="w-full bg-transparent hover:bg-neutral-55 text-black font-sans text-[10px] tracking-widest uppercase font-bold py-2.5 border border-black/15 transition-all text-center cursor-pointer"
                      >
                        Back to Email Verification
                      </button>
                    </div>
                  </form>
                )}

                {forgotStep === 3 && (
                  <div className="space-y-4 text-center">
                    <div className="w-12 h-12 bg-emerald-100 text-emerald-800 border border-emerald-600/20 rounded-full flex items-center justify-center mx-auto text-lg font-bold">✓</div>
                    <p className="text-xs font-sans font-bold text-slate-800 uppercase tracking-widest">Password Securely Reset</p>
                    <p className="text-xs text-slate-500 font-serif leading-relaxed">
                      Password credentials have been updated. You can now immediately sign in below with your new credentials.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setIsForgotMode(false);
                        setForgotStep(1);
                        setForgotEmail("");
                        setLoginError("");
                      }}
                      className="w-full bg-black hover:bg-neutral-800 text-[#F9F7F2] font-sans text-[10px] tracking-widest uppercase font-black py-3 border border-black transition-all text-center cursor-pointer"
                    >
                      Continue to Sign In
                    </button>
                  </div>
                )}
              </div>
            ) : !isSigningUp ? (
              <>
                {loginSubStep === 1 ? (
                  <>
                    <div className="text-center">
                      <span className="text-[40px] block mb-2 leading-none">🔒</span>
                      <h2 className="text-xl font-serif italic text-black">State Observer Gateway</h2>
                      <p className="text-[10px] font-sans tracking-wide text-slate-500 mt-1 uppercase max-w-[320px] mx-auto leading-relaxed">
                        Accredit with your observer workspace credentials and secure account password.
                      </p>
                    </div>

                    <form onSubmit={handleLogin} className="space-y-4 text-xs font-serif">
                      <div>
                        <label className="block text-[10px] font-sans uppercase tracking-wider text-slate-600 mb-1.5">Select OTP Dissemination Route</label>
                        <div className="grid grid-cols-2 gap-2 mt-1">
                          <button
                            type="button"
                            disabled={loginLoading}
                            onClick={() => setLoginOtpChoice("email")}
                            className={`py-2 text-[10px] tracking-wider uppercase border text-center transition-colors font-bold ${
                              loginOtpChoice === "email"
                                ? "bg-black text-[#F9F7F2] border-black"
                                : "bg-transparent text-[#121212]/70 border-black/15 hover:border-black/50"
                            } ${loginLoading ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                          >
                            📧 Email delivery
                          </button>
                          <button
                            type="button"
                            disabled={loginLoading}
                            onClick={() => setLoginOtpChoice("phone")}
                            className={`py-2 text-[10px] tracking-wider uppercase border text-center transition-colors font-bold ${
                              loginOtpChoice === "phone"
                                ? "bg-black text-[#F9F7F2] border-black"
                                : "bg-transparent text-[#121212]/70 border-black/15 hover:border-black/50"
                            } ${loginLoading ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                          >
                            📱 Mobile SMS
                          </button>
                        </div>
                      </div>

                      <div>
                        <label className="block text-[10px] font-sans uppercase tracking-wider text-slate-600 mb-1">Observer Email / Identifier</label>
                        <input
                          type="email"
                          required
                          disabled={loginLoading}
                          value={loginEmail}
                          onChange={(e) => setLoginEmail(e.target.value)}
                          placeholder="e.g. observer@peoplepulse.ap"
                          className="w-full bg-[#F9F7F2] border border-black/15 focus:border-black p-3 focus:outline-none text-xs font-mono rounded-none text-black disabled:opacity-60"
                        />
                      </div>

                      {loginOtpChoice === "phone" && (
                        <div>
                          <label className="block text-[10px] font-sans uppercase tracking-wider text-slate-600 mb-1">Provided Phone Number</label>
                          <input
                            type="tel"
                            required
                            disabled={loginLoading}
                            value={loginPhone}
                            onChange={(e) => setLoginPhone(e.target.value)}
                            placeholder="e.g. +91 98480 22338"
                            className="w-full bg-[#F9F7F2] border border-black/15 focus:border-black p-3 focus:outline-none text-xs font-mono rounded-none text-black disabled:opacity-60"
                          />
                        </div>
                      )}

                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <label className="block text-[10px] font-sans uppercase tracking-wider text-slate-600">Password</label>
                          <div className="relative group inline-block">
                            <span className="cursor-help text-[9px] bg-slate-100 hover:bg-slate-200 text-slate-500 rounded-full w-3.5 h-3.5 inline-flex items-center justify-center font-bold">?</span>
                            <div className="absolute right-0 bottom-full mb-1.5 hidden group-hover:block w-48 bg-black text-white text-[9.5px] p-2.5 font-sans font-normal normal-case rounded shadow-lg z-50 leading-relaxed text-left">
                              <strong className="font-semibold text-red-400">Password Criteria:</strong>
                              <ul className="list-disc pl-3 mt-1 space-y-0.5 text-slate-300">
                                <li>At least 6 characters</li>
                                <li>At least one letter (a-z / A-Z)</li>
                                <li>At least one number (0-9)</li>
                              </ul>
                              <div className="absolute top-full right-1 border-4 border-transparent border-t-black"></div>
                            </div>
                          </div>
                        </div>
                        <div className="relative">
                          <input
                            type={showPassword ? "text" : "password"}
                            required
                            disabled={loginLoading}
                            value={loginPassword}
                            onChange={(e) => setLoginPassword(e.target.value)}
                            placeholder="e.g. ••••••••"
                            className="w-full bg-[#F9F7F2] border border-black/15 focus:border-black p-3 pr-10 focus:outline-none text-xs rounded-none text-black font-mono disabled:opacity-60"
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword(!showPassword)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-black focus:outline-none cursor-pointer"
                            title={showPassword ? "Hide Password" : "Show Password"}
                          >
                            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                        <div className="text-right mt-1.5 animate-pulse-subtle">
                          <button
                            type="button"
                            onClick={() => {
                              setIsForgotMode(true);
                              setForgotStep(1);
                              setForgotEmail(loginEmail); // Pre-fill with entered email for perfect UX
                              setForgotOtp("");
                              setForgotOtpInput("");
                              setForgotNewPassword("");
                              setForgotError("");
                            }}
                            className="text-[9.5px] font-sans uppercase tracking-wider font-bold text-red-800 hover:text-red-900 hover:underline cursor-pointer"
                          >
                            Forgot Password?
                          </button>
                        </div>
                      </div>

                      {loginSuccessMessage && (
                        <div className="bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800/30 p-2.5 text-[10px] text-green-800 dark:text-green-400 font-mono block leading-normal">
                          ✅ {loginSuccessMessage}
                        </div>
                      )}

                      {loginError && (
                        <span className="text-[10px] text-red-700 font-semibold font-mono block leading-normal">{loginError}</span>
                      )}

                      <div className="pt-1">
                        <button
                          type="submit"
                          disabled={loginLoading}
                          className="w-full bg-black hover:bg-neutral-800 disabled:bg-neutral-400 text-[#F9F7F2] font-sans text-[10px] tracking-widest uppercase font-black py-3 border border-black transition-all cursor-pointer flex items-center justify-center space-x-2"
                        >
                          {loginLoading ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              <span>Verifying Credentials...</span>
                            </>
                          ) : (
                            <span>Verify Gate Credentials</span>
                          )}
                        </button>
                      </div>
                    </form>
                  </>
                ) : (
                  <>
                    <div className="text-center">
                      <span className="text-[40px] block mb-2 leading-none">🛡️</span>
                      <h2 className="text-xl font-serif italic text-black">Validate Secure OTP</h2>
                      <p className="text-[10px] font-sans tracking-wide text-slate-500 mt-1 uppercase max-w-[320px] mx-auto leading-relaxed">
                        Authorized device security key required to accredit observer clearance.
                      </p>
                    </div>

                    <div className="bg-emerald-50 border border-emerald-500/20 p-3 text-[10.5px] text-emerald-800 leading-snug">
                      {otpDispatchedMessage}
                    </div>

                    {/* Dynamic Admin-only verification override display */}
                    {validatedUserObj && (validatedUserObj.role === UserRole.SuperAdmin || validatedUserObj.role === UserRole.StateAdministrator) && (
                      <div className="bg-[#FAF8F5] border border-red-800/20 p-4 text-center rounded-none shadow-sm animate-fade-in space-y-1.5">
                        <span className="text-[8px] bg-[#A01D24] text-white px-2 py-0.5 tracking-widest font-sans font-bold uppercase">
                          Administrator Bypass Override
                        </span>
                        <div className="text-[11px] font-sans tracking-wide text-red-950 font-bold">
                          Validation OTP Code:
                        </div>
                        <div className="text-2xl font-mono tracking-[0.25em] font-black text-black bg-red-50/50 py-1.5 border border-red-200 select-all">
                          {dispatchedOtp}
                        </div>
                        <p className="text-[9.5px] text-slate-500 leading-normal font-serif max-w-xs mx-auto">
                          State Observers and Admins are granted on-screen authentication clearance for fluid operations dispatch.
                        </p>
                      </div>
                    )}

                    <form onSubmit={handleLogin} className="space-y-4 text-xs font-serif">
                      <div>
                        <label className="block text-[10px] font-sans uppercase tracking-wider text-slate-600 mb-1.5 text-center">Verify 6-Digit OTP Security Key</label>
                        <input
                          type="text"
                          required
                          disabled={loginLoading}
                          maxLength={6}
                          value={loginOtpInput}
                          onChange={(e) => setLoginOtpInput(e.target.value.replace(/\D/g, ''))}
                          placeholder="e.g. 123456"
                          className="w-full bg-[#F9F7F2] border border-black/15 focus:border-black p-3.5 focus:outline-none text-center text-lg font-mono tracking-[0.4em] font-black rounded-none text-black disabled:opacity-65"
                        />
                      </div>

                      {loginError && (
                        <span className="text-[10px] text-red-700 font-semibold font-mono block text-center">{loginError}</span>
                      )}

                      <div className="pt-1">
                        <button
                          type="submit"
                          disabled={loginLoading}
                          className="w-full bg-black hover:bg-neutral-800 disabled:bg-neutral-400 text-[#F9F7F2] font-sans text-[10px] tracking-widest uppercase font-black py-3 border border-black transition-all cursor-pointer flex items-center justify-center space-x-2"
                        >
                          {loginLoading ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              <span>Authenticating Session...</span>
                            </>
                          ) : (
                            <span>Validate & Log In</span>
                          )}
                        </button>
                      </div>
                    </form>

                    <div className="flex items-center justify-between pt-2 text-[10px] font-sans">
                      <button
                        type="button"
                        disabled={loginLoading}
                        onClick={() => {
                          setLoginSubStep(1);
                          setLoginError("");
                        }}
                        className="text-slate-500 hover:text-black transition-colors font-bold uppercase tracking-wider disabled:opacity-50"
                      >
                        ← Back to Credentials
                      </button>
                      <button
                        type="button"
                        disabled={loginLoading}
                        onClick={handleResendOtp}
                        className="text-slate-500 hover:text-black transition-colors font-bold uppercase tracking-wider disabled:opacity-50 flex items-center space-x-0.5 pointer"
                      >
                        {loginLoading && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                        <span>Resend OTP Code ↻</span>
                      </button>
                    </div>
                  </>
                )}

                <div className="pt-4 border-t border-black/5 text-center space-y-3">
                  <p className="text-[10px] text-slate-500 font-serif leading-relaxed">
                    * Authenticated secure workspace directory validation. Observers are verified against the validated constituency database register.
                  </p>

                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        setIsSigningUp(true);
                        setSignupStep(1);
                        setSignupSuccess(false);
                        setSignupError("");
                        setLoginSuccessMessage("");
                      }}
                      className="text-[10px] tracking-widest uppercase font-black text-black hover:underline underline-offset-4 cursor-pointer"
                    >
                      Create Observer Account →
                    </button>
                  </div>
                </div>
              </>
            ) : signupSuccess ? (
              /* CELEBRATORY SIGNUP ACCREDITATION CARD */
              <div className="space-y-6">
                <div className="text-center space-y-2">
                  <div className="w-12 h-12 bg-green-100 dark:bg-green-950/40 border border-green-600/30 rounded-full flex items-center justify-center mx-auto animate-bounce">
                    <CheckCircle2 className="w-6 h-6 text-green-700" />
                  </div>
                  <h3 className="text-lg font-serif italic text-black">Credentials Accreted</h3>
                  <p className="text-[10px] font-sans uppercase tracking-widest text-[#8D6E63] dark:text-[#A39988]">
                    Credential Verification Successful
                  </p>
                </div>

                <div className="border border-dashed border-black/20 p-4 font-mono text-[10px] space-y-2.5 bg-black/[0.02]">
                  <div className="flex justify-between">
                    <span className="text-slate-400">IDENTIFIER:</span>
                    <span className="font-bold text-black uppercase">AP-{Math.floor(100000 + Math.random() * 900000)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">OBSERVER:</span>
                    <span className="font-bold text-black">{signupName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">EMAIL:</span>
                    <span className="text-black">{signupEmail}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">JURISDICTION:</span>
                    <span className="text-black">
                      {DISTRICTS.find(d => d.id === signupDistrictId)?.name || signupDistrictId}
                    </span>
                  </div>
                  <div className="flex justify-between border-t border-dashed border-black/15 pt-2 mt-2">
                    <span className="text-slate-400">STATUS:</span>
                    <span className="text-green-700 font-bold uppercase tracking-wide">● VERIFIED PROVISIONAL</span>
                  </div>
                </div>

                <p className="text-[10px] text-slate-500 font-serif leading-relaxed text-center">
                  Your simulated observer credential has been entered into the local state. You may now load your customized workspace view.
                </p>

                <button
                  type="button"
                  onClick={handleOnboardComplete}
                  className="w-full bg-black hover:bg-neutral-800 text-[#F9F7F2] font-sans text-[10px] tracking-widest uppercase font-black py-3 border border-black transition-all cursor-pointer block text-center"
                >
                  Enter Simulated Workspace Console
                </button>
              </div>
            ) : (
              /* REGISTRATION STEPS CONTAINER */
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-serif italic text-black">New Observer Registration</h3>
                  <p className="text-[10px] font-sans uppercase tracking-wide text-slate-500">
                    Register credentials to simulation workspace
                  </p>
                </div>

                {/* Horizontal Progress bar steps progress indicator */}
                <div className="grid grid-cols-3 gap-2 text-[9px] font-sans tracking-widest uppercase pb-2 border-b border-black/5">
                  <div className="text-center">
                    <span className={`block font-bold pb-1 ${signupStep === 1 ? "text-black border-b-2 border-black" : "text-slate-400"}`}>1. Account</span>
                  </div>
                  <div className="text-center">
                    <span className={`block font-bold pb-1 ${signupStep === 2 ? "text-black border-b-2 border-black" : "text-slate-400"}`}>2. Level</span>
                  </div>
                  <div className="text-center">
                    <span className={`block font-bold pb-1 ${signupStep === 3 ? "text-black border-b-2 border-black" : "text-slate-400"}`}>3. Oath</span>
                  </div>
                </div>

                {signupError && (
                  <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 p-2 text-[10px] text-red-700 font-sans tracking-wide">
                    ⚠️ {signupError}
                  </div>
                )}

                <form onSubmit={signupStep === 3 ? handleSignupSubmit : handleSignupNext} className="space-y-4 text-xs">
                  {/* STEP 1: INITIAL CREDENTIALS */}
                  {signupStep === 1 && (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-[10px] font-sans uppercase tracking-wider text-slate-600 mb-1">Full Legal Name *</label>
                        <input
                          type="text"
                          required
                          value={signupName}
                          onChange={(e) => setSignupName(e.target.value)}
                          placeholder="e.g. Dr. Haritha Murthy"
                          className="w-full bg-[#F9F7F2] border border-black/15 focus:border-black p-3 focus:outline-none text-xs rounded-none text-black"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] font-sans uppercase tracking-wider text-slate-600 mb-1">Observer Email Address *</label>
                        <input
                          type="email"
                          required
                          value={signupEmail}
                          onChange={(e) => setSignupEmail(e.target.value)}
                          placeholder="haritha@observer.ap.gov.in"
                          className="w-full bg-[#F9F7F2] border border-black/15 focus:border-black p-3 focus:outline-none text-xs font-mono rounded-none text-black"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <label className="block text-[10px] font-sans uppercase tracking-wider text-slate-600">Password *</label>
                            <div className="relative group inline-block">
                              <span className="cursor-help text-[9px] bg-slate-100 hover:bg-slate-200 text-slate-500 rounded-full w-3.5 h-3.5 inline-flex items-center justify-center font-bold">?</span>
                              <div className="absolute right-0 bottom-full mb-1.5 hidden group-hover:block w-44 bg-black text-white text-[9.5px] p-2.5 font-sans font-normal normal-case rounded shadow-lg z-50 leading-relaxed text-left">
                                <strong className="font-semibold text-red-400">Password Criteria:</strong>
                                <ul className="list-disc pl-3 mt-1 space-y-0.5 text-slate-300">
                                  <li>At least 6 characters</li>
                                  <li>At least one letter</li>
                                  <li>At least one number</li>
                                </ul>
                                <div className="absolute top-full right-1 border-4 border-transparent border-t-black"></div>
                              </div>
                            </div>
                          </div>
                          <input
                            type="password"
                            required
                            value={signupPassword}
                            onChange={(e) => setSignupPassword(e.target.value)}
                            placeholder="Min 6 characters"
                            className="w-full bg-[#F9F7F2] border border-black/15 focus:border-black p-3 focus:outline-none text-xs rounded-none text-black"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-sans uppercase tracking-wider text-slate-600 mb-1">Phone Contact</label>
                          <input
                            type="text"
                            value={signupPhone}
                            onChange={(e) => setSignupPhone(e.target.value)}
                            placeholder="+91 XXXXX XXXXX"
                            className="w-full bg-[#F9F7F2] border border-black/15 focus:border-black p-3 focus:outline-none text-xs font-mono rounded-none text-black"
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* STEP 2: ASSIGN JURISDICTION */}
                  {signupStep === 2 && (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-[10px] font-sans uppercase tracking-wider text-slate-600 mb-1">State District Jurisdiction</label>
                        <select
                          value={signupDistrictId}
                          onChange={(e) => setSignupDistrictId(e.target.value)}
                          className="w-full bg-[#F9F7F2] border border-black/15 focus:border-black p-2.5 focus:outline-none text-xs rounded-none text-black"
                        >
                          {DISTRICTS.map((dst) => (
                            <option key={dst.id} value={dst.id}>{dst.name} ({dst.region})</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-[10px] font-sans uppercase tracking-wider text-slate-600 mb-1">Organization Affiliation</label>
                        <input
                          type="text"
                          value={signupAffiliation}
                          onChange={(e) => setSignupAffiliation(e.target.value)}
                          placeholder="e.g. Center for Democratic Audit, AP"
                          className="w-full bg-[#F9F7F2] border border-black/15 focus:border-black p-3 focus:outline-none text-xs rounded-none text-black"
                        />
                      </div>
                    </div>
                  )}

                  {/* STEP 3: OATH OF UNBIASED FIELD INSIGHTS */}
                  {signupStep === 3 && (
                    <div className="space-y-3">
                      <div className="bg-[#FAF8F5] border border-black/10 p-3 text-[10px] leading-relaxed space-y-1">
                        <p className="font-bold text-black uppercase tracking-wider text-[9px]">Information Summary Check:</p>
                        <div className="font-mono text-slate-600 space-y-0.5">
                          <div><span className="text-black">Registering:</span> {signupName}</div>
                          <div><span className="text-black">Target Email:</span> {signupEmail}</div>
                          <div><span className="text-black">Jurisdiction:</span> {DISTRICTS.find(d => d.id === signupDistrictId)?.name}</div>
                        </div>
                      </div>

                      <div className="border border-black/10 p-3.5 space-y-2 bg-[#F9F7F2]">
                        <span className="text-[10px] uppercase font-bold tracking-widest text-slate-800 block">Simulated Audit Oath</span>
                        <p className="text-[9px] text-slate-500 leading-relaxed italic">
                          "I solemnly declare and affirm that the survey submissions, validation actions, and demographic data audits I process in this workspace will remain completely independent, reliable, free from partisan bias, and adhere to accurate field observation standards."
                        </p>
                        
                        <label className="flex items-start space-x-2 pt-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={signupOathChecked}
                            onChange={(e) => setSignupOathChecked(e.target.checked)}
                            className="mt-0.5 rounded-none border-black/15 text-black"
                          />
                          <span className="text-[9px] uppercase tracking-wide font-bold text-black leading-tight">
                            I Affirm &amp; Accept Simulated Audit Oath
                          </span>
                        </label>
                      </div>
                    </div>
                  )}

                  {/* NAV-CONTROL BUTTONS */}
                  <div className="flex space-x-2 pt-2">
                    {signupStep > 1 && (
                      <button
                        type="button"
                        onClick={handleSignupPrev}
                        className="w-1/3 bg-transparent hover:bg-black/5 text-black border border-black font-sans text-[10px] tracking-widest uppercase font-bold py-3 transition-all"
                      >
                        Back
                      </button>
                    )}
                    <button
                      type="submit"
                      className={`font-sans text-[10px] tracking-widest uppercase font-black py-3 border border-black transition-all cursor-pointer ${
                        signupStep === 3 ? "w-full bg-red-800 text-white border-red-800 hover:bg-red-900" : signupStep === 1 ? "w-full bg-black text-[#F9F7F2] hover:bg-neutral-800" : "flex-1 bg-black text-[#F9F7F2] hover:bg-neutral-800"
                      }`}
                    >
                      {signupStep === 3 ? "Complete Registration" : "Continue"}
                    </button>
                  </div>
                </form>

                <div className="pt-4 border-t border-black/5 text-center">
                  <button
                    type="button"
                    onClick={() => {
                      setIsSigningUp(false);
                      setSignupStep(1);
                      setSignupError("");
                      setLoginSuccessMessage("");
                    }}
                    className="text-[10px] tracking-widest uppercase font-black text-black hover:underline underline-offset-4 cursor-pointer"
                  >
                    ← Already have an account? Sign In
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 10: ADMIN ACTIONS WORKSPACE */}
        {currentTab === "admin" && isLoggedIn && currentUserEmail.toLowerCase().trim() === "admin@peoplepulse.ap" ? (
          <>
          <DataStatusPanel />
          <AdminPortal
            currentUserRole={currentUserRole}
            setCurrentUserRole={setCurrentUserRole}
            surveyResponses={surveyResponses}
            onApproveResponse={handleApproveResponse}
            onFlagResponse={handleFlagResponse}
          />
          </>
        ) : currentTab === "admin" ? (
          <div className="bg-[#FAF8F5] text-black p-8 border border-black max-w-xl mx-auto text-center my-12 space-y-4">
            <ShieldAlert className="w-12 h-12 text-red-700 mx-auto animate-pulse" />
            <h3 className="text-xl font-serif italic">Access Denied</h3>
            <p className="text-xs text-slate-600 font-sans leading-relaxed">
              The administrator console and data audit operations are restricted. Only the authorized administrator account (<strong className="font-semibold select-all text-black">admin@peoplepulse.ap</strong>) has authorization to view this panel.
            </p>
            <button
              onClick={() => setCurrentTab("home")}
              className="bg-black hover:bg-neutral-800 text-white font-sans text-[10px] tracking-widest uppercase font-bold py-2.5 px-6 cursor-pointer"
            >
              Back to Home
            </button>
          </div>
        ) : null}

      </main>

      {/* Footer Section */}
      <footer className="bg-[#FAF8F5] text-[#121212] border-t border-black grid grid-cols-1 md:grid-cols-12 gap-8 px-8 sm:px-12 py-12 text-xs font-serif">
        
        {/* Brand focus */}
        <div className="md:col-span-5 space-y-4">
          <div className="flex items-center space-x-2">
            <div className="border border-black bg-black text-[#FAF8F5] p-2 flex items-center justify-center">
              <Vote className="w-4 h-4" />
            </div>
            <strong className="text-black font-sans text-xs tracking-[0.25em] uppercase font-black">PEOPLE PULSE ANDHRA PRADESH</strong>
          </div>
          <p className="text-slate-650 leading-relaxed text-[11px] max-w-sm text-justify">
            Continuous statewide scientific voter opinions registries, MLA approval metrics, regional issue hot-spotting matrices, and assembly-to-mandal historical telemetry. Covering 175 constituencies.
          </p>
          <span className="block text-[10px] text-slate-500 font-mono">© 2026 People Pulse Andhra Pradesh. All Rights Reserved.</span>
        </div>

        {/* Links rail 1 */}
        <div className="md:col-span-3 space-y-2 font-sans text-[10px]">
          <strong className="text-black block uppercase tracking-[0.2em] font-black pb-2 border-b border-black/10">Resources</strong>
          <button onClick={() => setCurrentTab("home")} className="block text-slate-650 hover:text-black hover:underline text-left">Home Dashboard</button>
          <button onClick={() => setCurrentTab("analytics")} className="block text-slate-650 hover:text-black hover:underline text-left">State Districts Heatmap</button>
          <button onClick={() => setCurrentTab("constituencies")} className="block text-slate-650 hover:text-black hover:underline text-left">All 175 Assembly Seats</button>
          <button onClick={() => setCurrentTab("methodology")} className="block text-slate-650 hover:text-black hover:underline text-left">Statistical Methodology</button>
        </div>

        {/* Links rail 2 */}
        <div className="md:col-span-4 space-y-2 font-sans text-[10px]">
          <strong className="text-black block uppercase tracking-[0.2em] font-black pb-2 border-b border-black/10">Compliance & Press Channel</strong>
          <button onClick={() => alert("Privacy policy is fully verified. We store no personal info, hashes, cookies or geo-tracking indicators.")} className="block text-slate-650 hover:text-black hover:underline text-left">Privacy Policy & Anonymity Compliance</button>
          <button onClick={() => alert("All survey participants agree to terms: duplicate checks match local phone identifiers only.")} className="block text-slate-650 hover:text-black hover:underline text-left">Terms of Scientific Participation</button>
          <button onClick={() => setCurrentTab("contact")} className="block text-slate-650 hover:text-black hover:underline text-left">Grievance Cell Escalation</button>
          <div className="flex space-x-3 pt-2 text-[10px] tracking-widest font-black uppercase">
            <span className="text-slate-500 hover:text-black cursor-pointer">FB</span>
            <span className="text-slate-500 hover:text-black cursor-pointer">X</span>
            <span className="text-slate-500 hover:text-black cursor-pointer">LN</span>
            <span className="text-slate-500 hover:text-black cursor-pointer">YT</span>
          </div>
        </div>

      </footer>

    </div>
  );
}

export default function App() {
  return (
    <LangProvider>
      <StateProvider>
        <AppInner />
      </StateProvider>
    </LangProvider>
  );
}
