/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, Square, Play, RotateCcw, ChevronRight, Heart, Music, Image as ImageIcon, Plus, Share2, X, Upload } from 'lucide-react';
import confetti from 'canvas-confetti';

import { db } from './firebase';
import { collection, addDoc, getDoc, doc, serverTimestamp } from 'firebase/firestore';

// --- Types & Constants ---

enum Step {
  LANDING,
  RECORDING,
  IMAGE_UPLOAD,
  KEEPSAKE_PLAYER,
  CAKE,
  FINAL_MESSAGE
}

const COLORS = {
  coffee: '#3d2b1f',
  mocha: '#6f4e37',
  beige: '#d2b48c',
  cream: '#fdfcf0',
  warmBrown: '#8b5e3c',
  darkBg: '#2a1b12',
};

// --- Utility Functions ---

const compressImage = (base64Str: string): Promise<string> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = base64Str;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      // Reduced dimensions for faster upload/download and better Firestore compatibility
      const MAX_WIDTH = 700;
      const MAX_HEIGHT = 700;
      let width = img.width;
      let height = img.height;

      if (width > height) {
        if (width > MAX_WIDTH) {
          height *= MAX_WIDTH / width;
          width = MAX_WIDTH;
        }
      } else {
        if (height > MAX_HEIGHT) {
          width *= MAX_HEIGHT / height;
          height = MAX_HEIGHT;
        }
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      // Use imageSmoothingEnabled for better quality at smaller sizes
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);
      }
      // Quality 0.6 is a sweet spot for performance vs visuals
      resolve(canvas.toDataURL('image/jpeg', 0.6));
    };
  });
};

// --- Components ---

export default function App() {
  const [step, setStep] = useState<Step>(Step.LANDING);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [audioBase64, setAudioBase64] = useState<string | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [isLoadingMemory, setIsLoadingMemory] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize AudioContext on first interaction
  const initAudio = async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }
  };

  // --- Step 1: Recording Logic ---

  const startRecording = async () => {
    await initAudio();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/ogg; codecs=opus' });
        
        // Parallelize base64 conversion and decoding for better performance
        const base64Promise = new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });

        const decodePromise = (async () => {
          const arrayBuffer = await blob.arrayBuffer();
          return await audioContextRef.current!.decodeAudioData(arrayBuffer);
        })();

        const [base64, decodedBuffer] = await Promise.all([base64Promise, decodePromise]);
        
        setAudioBase64(base64);
        setAudioBuffer(decodedBuffer);
        setStep(Step.IMAGE_UPLOAD);
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } catch (err) {
      console.error("Error accessing microphone:", err);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      setIsRecording(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      Array.from(files).forEach((file: File) => {
        const reader = new FileReader();
        reader.onload = async (ev) => {
          if (ev.target?.result) {
            const compressed = await compressImage(ev.target.result as string);
            setImages(prev => [...prev, compressed]);
          }
        };
        reader.readAsDataURL(file);
      });
    }
  };

  const [isGenerating, setIsGenerating] = useState(false);
  const [shareId, setShareId] = useState<string | null>(null);

  // Load shared memory if ID exists in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    if (id) {
      console.log("Found share ID, loading memory:", id);
      setIsLoadingMemory(true);
      setLoadError(null);
      
      // Safety timeout to prevent infinite loading state
      const timeoutId = setTimeout(() => {
        setIsLoadingMemory(false);
        setLoadError("Loading timed out. Please refresh.");
      }, 12000);

      const loadMemory = async () => {
        try {
          const docRef = doc(db, 'memories', id);
          const docSnap = await getDoc(docRef);
          
          if (docSnap.exists()) {
            const data = docSnap.data();
            setShareId(id);
            
            // Start audio decoding immediately without waiting for images
            const audioPromise = (async () => {
              const audioData = data.audioData;
              if (!audioData) throw new Error("No audio data");
              
              if (!audioContextRef.current) {
                audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
              }
              
              const response = await fetch(audioData);
              const arrayBuffer = await response.arrayBuffer();
              return await audioContextRef.current.decodeAudioData(arrayBuffer);
            })();

            // Set images immediately
            setImages(data.images || []);
            
            // Wait for audio to finish decoding
            const decodedBuffer = await audioPromise;
            setAudioBuffer(decodedBuffer);
            setStep(Step.KEEPSAKE_PLAYER);
          } else {
            throw new Error("Memory not found");
          }
        } catch (err) {
          console.error("Error loading memory:", err);
          setLoadError(err instanceof Error ? err.message : "Failed to load memory");
        } finally {
          clearTimeout(timeoutId);
          setIsLoadingMemory(false);
        }
      };
      loadMemory();
    }
  }, []);

  const startApp = async () => {
    await initAudio();
    if (audioContextRef.current) {
      await audioContextRef.current.resume();
    }
    setStep(Step.RECORDING);
  };

  const handleFinishUpload = async () => {
    setIsGenerating(true);
    
    try {
      if (audioBase64 && images.length > 0) {
        const docRef = await addDoc(collection(db, 'memories'), {
          audioData: audioBase64,
          images: images,
          createdAt: serverTimestamp()
        });
        setShareId(docRef.id);
      }
    } catch (e) {
      console.error("Error saving memory:", e);
    }

    setStep(Step.KEEPSAKE_PLAYER);
    setIsGenerating(false);
  };

  return (
    <div className="min-h-screen bg-dark-bg text-cream flex flex-col items-center justify-center p-4 py-12 sm:py-20 overflow-x-hidden selection:bg-mocha selection:text-white">
      <AnimatePresence mode="wait">
        {isLoadingMemory && (
          <motion.div
            key="loading-memory"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center gap-6"
          >
            <div className="w-16 h-16 border-4 border-beige/20 border-t-beige rounded-full animate-spin" />
            <p className="font-serif italic text-beige text-xl animate-pulse">Unfolding a special memory...</p>
          </motion.div>
        )}

        {loadError && (
          <motion.div
            key="load-error"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center p-8 glass rounded-3xl border border-red-500/30 max-w-sm mx-4"
          >
            <X className="text-red-500 mx-auto mb-4" size={48} />
            <h2 className="text-xl font-serif text-beige mb-2">Couldn't open memory</h2>
            <p className="text-mocha text-sm mb-6">{loadError}</p>
            <button 
              onClick={() => {
                setLoadError(null);
                setStep(Step.LANDING);
              }}
              className="bg-mocha text-cream px-8 py-3 rounded-xl font-bold"
            >
              Go to Home
            </button>
          </motion.div>
        )}

        {!isLoadingMemory && !loadError && step === Step.LANDING && (
          <motion.div
            key="landing"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.1 }}
            className="text-center flex flex-col items-center"
          >
            <div className="mb-16 relative">
              <motion.div 
                animate={{ 
                  y: [0, -20, 0],
                  rotate: [0, 5, -5, 0]
                }}
                transition={{ 
                  duration: 6, 
                  repeat: Infinity, 
                  ease: "easeInOut" 
                }}
                className="relative w-48 h-48 md:w-64 md:h-64 flex items-center justify-center"
              >
                <div className="absolute inset-0 bg-mocha/20 rounded-full blur-3xl animate-pulse" />
                <div className="relative z-10 w-full h-full glass rounded-3xl border border-white/20 shadow-2xl flex items-center justify-center overflow-hidden group">
                  <div className="absolute inset-0 bg-gradient-to-br from-mocha/20 to-transparent opacity-50" />
                  <motion.div
                    animate={{ scale: [1, 1.1, 1] }}
                    transition={{ duration: 4, repeat: Infinity }}
                  >
                    <Heart size={80} className="text-beige fill-beige/20 drop-shadow-[0_0_15px_rgba(210,180,140,0.5)]" />
                  </motion.div>
                  
                  {/* Floating Sparkles */}
                  <motion.div 
                    animate={{ opacity: [0, 1, 0], scale: [0.5, 1, 0.5] }}
                    transition={{ duration: 2, repeat: Infinity, delay: 0.5 }}
                    className="absolute top-10 right-10 text-beige"
                  >
                    <ImageIcon size={20} />
                  </motion.div>
                  <motion.div 
                    animate={{ opacity: [0, 1, 0], scale: [0.5, 1, 0.5] }}
                    transition={{ duration: 2, repeat: Infinity, delay: 1.2 }}
                    className="absolute bottom-12 left-12 text-beige"
                  >
                    <Plus size={20} />
                  </motion.div>
                </div>
              </motion.div>
            </div>
            
            <motion.h1 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="font-serif text-4xl sm:text-6xl md:text-7xl lg:text-8xl mb-8 text-beige tracking-tight leading-none px-4"
            >
              Voice note <br/> <span className="italic font-light">keepsake</span>
            </motion.h1>
            
            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.6 }}
              onClick={startApp}
              className="group relative bg-mocha text-cream px-16 py-5 rounded-2xl text-xl font-medium overflow-hidden transition-all hover:shadow-[0_0_30px_rgba(111,78,55,0.4)] active:scale-95"
            >
              <div className="absolute inset-0 bg-white/10 translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
              <span className="relative z-10 flex items-center gap-3">
                Start Experience <ChevronRight size={24} className="group-hover:translate-x-1 transition-transform" />
              </span>
            </motion.button>
          </motion.div>
        )}

        {step === Step.RECORDING && (
          <motion.div
            key="recording"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.05 }}
            className="text-center max-w-md w-full glass p-8 sm:p-12 rounded-[2rem] sm:rounded-[3rem] border border-white/10 shadow-3xl mx-4"
          >
            <h1 className="font-serif text-3xl sm:text-5xl mb-4 sm:mb-6 text-beige">Record your heart</h1>
            <p className="text-mocha mb-8 sm:mb-16 font-light text-sm sm:text-lg">Speak softly. This voice note will be the soul of your keepsake.</p>
            
            <div className="relative inline-block mb-8 sm:mb-12">
              <AnimatePresence>
                {isRecording && (
                  <>
                    <motion.div
                      initial={{ scale: 1, opacity: 0.5 }}
                      animate={{ scale: 1.8, opacity: 0 }}
                      transition={{ repeat: Infinity, duration: 1.5 }}
                      className="absolute inset-0 bg-mocha rounded-full -z-10"
                    />
                    <motion.div
                      initial={{ scale: 1, opacity: 0.3 }}
                      animate={{ scale: 2.2, opacity: 0 }}
                      transition={{ repeat: Infinity, duration: 2, delay: 0.5 }}
                      className="absolute inset-0 bg-mocha rounded-full -z-10"
                    />
                  </>
                )}
              </AnimatePresence>
              
              <button
                onClick={isRecording ? stopRecording : startRecording}
                className={`w-32 h-32 rounded-full flex items-center justify-center transition-all duration-500 shadow-[0_0_50px_rgba(0,0,0,0.3)] group ${
                  isRecording ? 'bg-red-500 hover:bg-red-600 scale-110' : 'bg-mocha hover:bg-warm-brown hover:scale-105'
                }`}
              >
                {isRecording ? (
                  <Square className="text-white w-10 h-10 fill-current" />
                ) : (
                  <Mic className="text-white w-12 h-12 group-hover:scale-110 transition-transform" />
                )}
              </button>
            </div>
            
            <div className="flex flex-col items-center gap-4">
              <div className="font-mono text-4xl text-beige tracking-[0.3em] font-bold">
                {isRecording ? formatTime(recordingTime) : "0:00"}
              </div>
              {isRecording && (
                <div className="flex gap-1 h-4 items-center">
                  {Array.from({ length: 12 }).map((_, i) => (
                    <motion.div
                      key={i}
                      animate={{ height: [4, Math.random() * 16 + 4, 4] }}
                      transition={{ repeat: Infinity, duration: 0.5 + Math.random() * 0.5 }}
                      className="w-1 bg-mocha rounded-full"
                    />
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}

        {step === Step.IMAGE_UPLOAD && (
          <motion.div
            key="image-upload"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="text-center max-w-3xl w-full glass p-6 sm:p-12 rounded-[2rem] sm:rounded-[3rem] border border-white/10 mx-4"
          >
            <h1 className="font-serif text-3xl sm:text-5xl mb-4 text-beige">Visual Memories</h1>
            <p className="text-mocha mb-6 sm:mb-12 font-light text-sm sm:text-lg">Pick the moments that make you smile.</p>
            
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 mb-8 sm:mb-16 max-h-[40vh] sm:max-h-[50vh] overflow-y-auto pr-2 custom-scrollbar">
              <AnimatePresence>
                {images.map((img, idx) => (
                  <motion.div 
                    key={idx}
                    initial={{ opacity: 0, scale: 0.8, rotate: -5 }}
                    animate={{ opacity: 1, scale: 1, rotate: 0 }}
                    exit={{ opacity: 0, scale: 0.8, rotate: 5 }}
                    className="relative aspect-square rounded-2xl overflow-hidden border-4 border-white shadow-lg group hover:scale-105 transition-transform"
                  >
                    <img src={img} alt={`Upload ${idx}`} className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <button 
                        onClick={() => setImages(prev => prev.filter((_, i) => i !== idx))}
                        className="p-2 bg-red-500 rounded-full text-white hover:bg-red-600 transition-colors"
                      >
                        <X size={20} />
                      </button>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
              
              <label className="aspect-square rounded-2xl border-2 border-dashed border-mocha/30 flex flex-col items-center justify-center cursor-pointer hover:border-beige hover:bg-white/5 transition-all group">
                <div className="w-12 h-12 rounded-full bg-mocha/10 flex items-center justify-center mb-3 group-hover:bg-mocha/20 transition-colors">
                  <Plus className="text-mocha group-hover:scale-110 transition-transform" />
                </div>
                <span className="text-xs text-mocha uppercase tracking-[0.2em] font-bold">Add Photo</span>
                <input type="file" multiple accept="image/*" className="hidden" onChange={handleImageUpload} />
              </label>
            </div>

            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={handleFinishUpload}
              disabled={isGenerating}
              className="bg-mocha text-cream px-12 py-4 rounded-2xl font-bold text-lg hover:bg-warm-brown transition-all flex items-center gap-3 mx-auto shadow-2xl disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isGenerating ? (
                <>
                  <RotateCcw className="animate-spin" size={24} /> Generating...
                </>
              ) : (
                <>
                  Finish Keepsake <ChevronRight size={24} />
                </>
              )}
            </motion.button>
          </motion.div>
        )}

        {step === Step.KEEPSAKE_PLAYER && audioBuffer && (
          <KeepsakePlayer 
            buffer={audioBuffer} 
            images={images}
            audioContext={audioContextRef.current!} 
            onNext={() => setStep(Step.CAKE)} 
            onReset={() => {
              setStep(Step.LANDING);
              setAudioBuffer(null);
              setImages([]);
            }}
            shareId={shareId}
          />
        )}

        {step === Step.CAKE && (
          <BirthdayCake 
            onNext={() => setStep(Step.FINAL_MESSAGE)} 
          />
        )}

        {step === Step.FINAL_MESSAGE && (
          <FinalMessage shareId={shareId} />
        )}
      </AnimatePresence>
    </div>
  );
}

// --- Keepsake Player Component ---

function KeepsakePlayer({ buffer, images, audioContext, onNext, onReset, shareId }: { buffer: AudioBuffer, images: string[], audioContext: AudioContext, onNext: () => void, onReset: () => void, shareId: string | null }) {
  const [rotation, setRotation] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isFinished, setIsFinished] = useState(false);
  const [itemWidth, setItemWidth] = useState(480);
  
  const handleRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const lastAngleRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(Date.now());
  const playbackTimeRef = useRef<number>(0);
  const velocityRef = useRef<number>(0);

  useEffect(() => {
    const updateWidth = () => {
      setItemWidth(window.innerWidth < 640 ? 224 + 48 : 384 + 96);
    };
    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  const updatePlayback = useCallback(() => {
    const now = Date.now();
    // Check if moving clockwise (positive velocity)
    const isMovingClockwise = isDragging && (now - lastTimeRef.current < 200) && velocityRef.current > 0.05;
    
    if (sourceRef.current) {
      // Play at normal speed (1.0) if moving clockwise and not finished, otherwise stop (0)
      const targetRate = (isMovingClockwise && !isFinished && playbackTimeRef.current < buffer.duration) ? 1.0 : 0;
      
      // Apply the rate with a very short ramp to avoid clicks
      sourceRef.current.playbackRate.setTargetAtTime(targetRate, audioContext.currentTime, 0.01);
      
      if (targetRate > 0) {
        // Update progress at normal speed
        playbackTimeRef.current += (1/60);
        
        // Strict cap
        if (playbackTimeRef.current >= buffer.duration) {
          playbackTimeRef.current = buffer.duration;
          setIsFinished(true);
        }
        
        const p = (playbackTimeRef.current / buffer.duration) * 100;
        setProgress(Math.min(p, 100));
      }
    }

    requestAnimationFrame(updatePlayback);
  }, [isDragging, audioContext, buffer.duration, isFinished]);

  useEffect(() => {
    const source = audioContext.createBufferSource();
    const gain = audioContext.createGain();
    
    source.buffer = buffer;
    source.loop = false;
    source.playbackRate.value = 0;
    
    gain.gain.value = 1.0;
    
    source.connect(gain);
    gain.connect(audioContext.destination);
    
    source.start(0);
    sourceRef.current = source;

    const animId = requestAnimationFrame(updatePlayback);
    return () => {
      cancelAnimationFrame(animId);
      try {
        source.stop();
      } catch (e) {}
    };
  }, [buffer, audioContext, updatePlayback]);

  const handleStart = async (e: React.MouseEvent | React.TouchEvent) => {
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    setIsDragging(true);
    lastAngleRef.current = null;
    lastTimeRef.current = Date.now();
  };

  const handleMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDragging || !handleRef.current) return;

    // Ensure context is running
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }

    const rect = handleRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    const angle = Math.atan2(clientY - centerY, clientX - centerX) * (180 / Math.PI);
    
    if (lastAngleRef.current !== null) {
      let delta = angle - lastAngleRef.current;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      
      // Only allow clockwise rotation (positive delta) for forward progress
      // or just use absolute for playback, but let's stick to rotation
      setRotation(prev => prev + delta);
      
      const now = Date.now();
      const dt = (now - lastTimeRef.current) / 1000;
      if (dt > 0) {
        // Smooth out velocity
        velocityRef.current = (velocityRef.current * 0.8) + (delta * 0.2);
      }
      lastTimeRef.current = now;
    }
    
    lastAngleRef.current = angle;
  };

  const handleEnd = () => {
    setIsDragging(false);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const [isCopied, setIsCopied] = useState(false);

  const handleShare = async () => {
    const baseUrl = window.location.href.split('?')[0];
    const url = shareId ? `${baseUrl}?id=${shareId}` : baseUrl;
    const shareData = {
      title: 'A Special Birthday Memory',
      text: 'I created a special birthday memory for you! Check it out.',
      url: url,
    };

    try {
      // Try native share first
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        throw new Error('Native share not available');
      }
    } catch (err) {
      // Fallback to clipboard for ANY error (including cancellation or iframe restrictions)
      try {
        await navigator.clipboard.writeText(url);
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
      } catch (clipErr) {
        console.error('Clipboard fallback failed:', clipErr);
      }
    }
  };

  return (
    <motion.div
      key="keepsake"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="relative w-full max-w-4xl min-h-screen flex flex-col items-center justify-center bg-[#3d2b1f] py-12 sm:py-20"
    >
      {/* Top Navigation */}
      <div className="absolute top-0 w-full grid grid-cols-3 items-center px-4 sm:px-8 py-4 sm:py-12 z-50">
        <div className="flex justify-start">
          <button 
            onClick={onReset}
            className="flex items-center gap-2 text-beige/80 hover:text-beige transition-colors text-xs sm:text-sm font-serif italic tracking-wider"
          >
            <RotateCcw size={18} /> <span className="hidden xs:inline">New memory</span>
          </button>
        </div>
        
        <div className="flex justify-center font-mono text-beige/60 tracking-[0.2em] sm:tracking-[0.3em] text-[10px] sm:text-sm whitespace-nowrap">
          {formatTime(playbackTimeRef.current)} / {formatTime(buffer.duration)}
        </div>

        <div className="flex justify-end">
          <button 
            onClick={handleShare}
            className="relative flex items-center gap-2 text-beige/80 hover:text-beige transition-colors text-xs sm:text-sm font-serif italic tracking-wider"
          >
            <Share2 size={18} /> <span className="hidden xs:inline">Share</span>
            <AnimatePresence>
              {isCopied && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="absolute -bottom-10 right-0 bg-beige text-dark-bg px-3 py-1.5 rounded-lg text-[10px] font-bold shadow-xl whitespace-nowrap"
                >
                  Link copied!
                </motion.div>
              )}
            </AnimatePresence>
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="relative w-full flex flex-col items-center gap-16">
        
        {/* Memory Photos Sequence - Sliding Film Strip (Movie Motion) */}
        <div className="relative w-full h-[40vh] sm:h-[45vh] flex items-center overflow-hidden">
          <motion.div 
            className="flex gap-12 sm:gap-24 px-[40vw] sm:px-[50vw]"
            animate={{ 
              x: `-${(progress / 100) * (images.length * itemWidth)}px`,
              rotateZ: isDragging && velocityRef.current > 0.05 && !isFinished ? [0, -0.3, 0.3, 0] : 0
            }}
            transition={{ 
              x: { type: "tween", ease: "linear", duration: 0 },
              rotateZ: { repeat: Infinity, duration: 2 }
            }}
          >
            {images.length > 0 ? images.map((img, idx) => (
              <motion.div 
                key={idx}
                initial={{ opacity: 0, scale: 0.9 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: false, margin: "-10%" }}
                className="flex-shrink-0 w-56 h-56 sm:w-72 sm:h-72 md:w-96 md:h-96 bg-white p-2 sm:p-4 shadow-[0_30px_60px_rgba(0,0,0,0.4)] border border-zinc-100 rounded-sm transform rotate-1 relative group"
              >
                {/* Film Perforations */}
                <div className="absolute top-0 left-0 w-full h-3 sm:h-4 flex justify-around px-2 pt-1 opacity-20">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="w-1.5 h-1.5 sm:w-2 sm:h-2 bg-black rounded-sm" />
                  ))}
                </div>
                <div className="absolute bottom-0 left-0 w-full h-3 sm:h-4 flex justify-around px-2 pb-1 opacity-20">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="w-1.5 h-1.5 sm:w-2 sm:h-2 bg-black rounded-sm" />
                  ))}
                </div>

                <div className="w-full h-full overflow-hidden bg-zinc-50 rounded-xs shadow-inner">
                  <img 
                    src={img} 
                    alt={`Memory ${idx}`} 
                    className="w-full h-full object-cover grayscale-[0.2] group-hover:grayscale-0 transition-all duration-700" 
                  />
                </div>
                <div className="mt-3 text-center font-serif text-zinc-400 text-[10px] italic uppercase tracking-[0.4em]">
                  Scene {idx + 1}
                </div>
              </motion.div>
            )) : (
              <div className="text-beige/20 italic font-serif">No memories to display</div>
            )}
          </motion.div>
          
          {/* Cinematic Overlays */}
          <div className="absolute inset-0 pointer-events-none bg-gradient-to-r from-[#3d2b1f] via-transparent to-[#3d2b1f] opacity-90" />
          <div className="absolute inset-0 pointer-events-none bg-[url('https://www.transparenttextures.com/patterns/stardust.png')] opacity-10 mix-blend-overlay" />
          
          {/* Center indicator line & Recording Motion */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center pointer-events-none">
            <div className="w-[1px] h-96 bg-beige/20 shadow-[0_0_15px_rgba(210,180,140,0.3)]" />
            
            {/* Recording Motion Indicator */}
            <div className="absolute top-0 flex items-center gap-1.5 bg-mocha/80 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/10 shadow-xl -translate-y-12">
              <motion.div 
                animate={{ opacity: velocityRef.current > 0.05 ? [1, 0, 1] : 1 }}
                transition={{ duration: 0.8, repeat: Infinity }}
                className={`w-2 h-2 rounded-full ${velocityRef.current > 0.05 ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]' : 'bg-zinc-500'}`}
              />
              <span className="text-[10px] uppercase tracking-widest font-bold text-beige/90">
                {velocityRef.current > 0.05 ? 'Playing' : 'Paused'}
              </span>
              
              {/* Mini Visualizer */}
              <div className="flex items-end gap-[2px] h-3 ml-1">
                {[1, 2, 3, 4].map((i) => (
                  <motion.div
                    key={i}
                    animate={{ height: velocityRef.current > 0.05 ? [2, 10, 4, 12, 2] : 2 }}
                    transition={{ duration: 0.5 + i * 0.1, repeat: Infinity }}
                    className="w-[2px] bg-beige/60 rounded-full"
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Vinyl Disc - Realistic Player Style */}
        <div className="relative flex flex-col items-center gap-10">
          <div className="absolute -inset-12 bg-black/20 blur-3xl rounded-full pointer-events-none" />
          
          <div 
            ref={handleRef}
            onMouseDown={handleStart}
            onMouseMove={handleMove}
            onMouseUp={handleEnd}
            onMouseLeave={handleEnd}
            onTouchStart={handleStart}
            onTouchMove={handleMove}
            onTouchEnd={handleEnd}
            className="relative w-56 h-56 sm:w-64 sm:h-64 md:w-80 md:h-80 cursor-grab active:cursor-grabbing select-none"
            style={{ transform: `rotate(${rotation}deg)` }}
          >
            {/* Realistic Vinyl Record */}
            <div className="absolute inset-0 rounded-full bg-[#050505] shadow-[0_0_80px_rgba(0,0,0,1)] border-[10px] border-[#1a1a1a] overflow-hidden">
              {/* Grooves - High Detail */}
              <div className="absolute inset-0 opacity-90" style={{ 
                background: 'repeating-radial-gradient(circle at center, transparent 0, transparent 1px, #000 2px, #000 3px)' 
              }} />
              
              {/* Conic Reflections */}
              <div className="absolute inset-0 bg-[conic-gradient(from_0deg,transparent_0deg,rgba(255,255,255,0.03)_45deg,transparent_90deg,rgba(255,255,255,0.03)_135deg,transparent_180deg,rgba(255,255,255,0.03)_225deg,transparent_270deg,rgba(255,255,255,0.03)_315deg,transparent_360deg)] pointer-events-none" />
              
              {/* Label */}
              <div className="absolute inset-[32%] rounded-full bg-[#4a3223] flex items-center justify-center border-[8px] border-[#3d2b1f]/50 shadow-inner">
                <div className="w-full h-full rounded-full bg-gradient-to-br from-white/5 to-transparent flex items-center justify-center">
                   {/* Heart removed as requested */}
                </div>
              </div>
              
              {/* Center Pin Hole */}
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-6 bg-[#000] rounded-full shadow-2xl border border-white/5 flex items-center justify-center">
                <div className="w-1.5 h-1.5 bg-white/10 rounded-full" />
              </div>

              {/* Vinyl String/Handle to rotate */}
              <div className="absolute top-6 left-1/2 -translate-x-1/2 flex flex-col items-center">
                <div className="w-[2px] h-10 bg-beige/40" />
                <div className="w-10 h-10 rounded-full bg-beige shadow-2xl border-4 border-mocha flex items-center justify-center -mt-2">
                  <div className="w-3 h-3 bg-mocha rounded-full" />
                </div>
              </div>
            </div>
          </div>

          <div className="text-beige/30 text-[10px] uppercase tracking-[0.6em] font-bold animate-pulse">
            Grab the handle to rotate
          </div>
        </div>

        <AnimatePresence>
          {(isFinished || progress >= 99.5) && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-4"
            >
              <div className="text-beige font-serif italic text-sm animate-bounce bg-black/40 px-4 py-1 rounded-full backdrop-blur-sm">
                The memory is complete...
              </div>
              <div className="flex gap-4 relative">
                <button
                  onClick={handleShare}
                  className="bg-mocha/90 text-beige px-6 py-4 rounded-full font-bold shadow-2xl hover:bg-mocha transition-all flex items-center gap-2 border border-white/10"
                >
                  <Share2 size={20} /> {isCopied ? 'Link Copied!' : 'Share Memory'}
                </button>
                <button
                  onClick={onNext}
                  className="bg-beige text-dark-bg px-10 py-4 rounded-full font-bold shadow-[0_0_40px_rgba(210,180,140,0.6)] hover:bg-cream transition-all flex items-center gap-2 group"
                >
                  Next Step <ChevronRight size={20} className="group-hover:translate-x-1 transition-transform" />
                </button>

                <AnimatePresence>
                  {isCopied && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className="absolute -top-12 left-0 bg-beige text-dark-bg px-4 py-2 rounded-lg text-xs font-bold shadow-xl whitespace-nowrap"
                    >
                      Link copied to clipboard!
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </div>

      <div className="mt-8 text-beige/40 text-xs uppercase tracking-[0.3em] font-light">
        Turn the handle clockwise
      </div>
    </motion.div>
  );
}

// --- Birthday Cake Component ---

function BirthdayCake({ onNext }: { onNext: () => void }) {
  const [candlesOut, setCandlesOut] = useState(false);
  const [isBlowing, setIsBlowing] = useState(false);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let audioContext: AudioContext;
    let source: MediaStreamAudioSourceNode;

    const startBlowingDetection = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        analyserRef.current = audioContext.createAnalyser();
        analyserRef.current.fftSize = 256;
        source = audioContext.createMediaStreamSource(stream);
        source.connect(analyserRef.current);

        const bufferLength = analyserRef.current.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const checkBlow = () => {
          if (candlesOut) return;
          analyserRef.current?.getByteFrequencyData(dataArray);
          
          let sum = 0;
          for (let i = 10; i < bufferLength; i++) {
            sum += dataArray[i];
          }
          const average = sum / (bufferLength - 10);

          if (average > 60) {
            setIsBlowing(true);
            setTimeout(() => {
              setCandlesOut(true);
              
              const scalar = 2.5;
              const shapes = [
                confetti.shapeFromText({ text: '🎂', scalar }),
                confetti.shapeFromText({ text: '🎁', scalar }),
                confetti.shapeFromText({ text: '🎈', scalar }),
                confetti.shapeFromText({ text: '✨', scalar }),
                confetti.shapeFromText({ text: '🍰', scalar }),
                confetti.shapeFromText({ text: '🎉', scalar }),
                confetti.shapeFromText({ text: '🎊', scalar }),
                'circle',
                'square'
              ];

              confetti({
                particleCount: 200,
                spread: 90,
                origin: { y: 0.6 },
                colors: [COLORS.mocha, COLORS.beige, '#FFD700', '#FF69B4', '#87CEEB'],
                shapes: shapes as any,
                scalar
              });
            }, 500);
          } else {
            setIsBlowing(false);
          }
          
          if (!candlesOut) requestAnimationFrame(checkBlow);
        };

        checkBlow();
      } catch (err) {
        console.error("Mic access denied for blowing detection", err);
      }
    };

    startBlowingDetection();

    return () => {
      streamRef.current?.getTracks().forEach(track => track.stop());
      if (audioContext) audioContext.close();
    };
  }, [candlesOut]);

  return (
    <motion.div
      key="cake"
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.2 }}
      className="text-center glass p-8 sm:p-12 rounded-[2rem] sm:rounded-[3rem] border border-white/10 shadow-3xl max-w-lg w-full mx-4"
    >
      <h2 className="font-serif text-4xl sm:text-5xl mb-4 sm:mb-6 text-beige">Make a Wish...</h2>
      <p className="text-mocha mb-8 sm:mb-16 italic font-light text-base sm:text-lg">Blow into your microphone to put out the candles!</p>

      <div className="relative w-56 h-56 sm:w-72 sm:h-72 mx-auto mb-8 sm:mb-16 scale-90 sm:scale-100">
        {/* Cake Base */}
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-56 h-28 bg-mocha rounded-t-[3rem] shadow-2xl border-b-8 border-coffee overflow-hidden">
           <div className="absolute top-4 left-0 w-full h-4 bg-white/10" />
           <div className="absolute top-12 left-0 w-full h-4 bg-white/5" />
        </div>
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 w-44 h-20 bg-beige rounded-t-[2.5rem] shadow-lg border-b-4 border-mocha/30 overflow-hidden">
           <div className="absolute top-4 left-0 w-full h-2 bg-white/20" />
        </div>
        
        {/* Frosting Drips */}
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 w-44 flex justify-around px-2">
          {[1,2,3,4,5,6].map(i => (
            <motion.div 
              key={i} 
              animate={{ height: [12, 16, 12] }}
              transition={{ duration: 2, repeat: Infinity, delay: i * 0.2 }}
              className="w-4 bg-beige rounded-full -mt-2 shadow-sm" 
            />
          ))}
        </div>

        {/* Candles */}
        <div className="absolute bottom-40 left-1/2 -translate-x-1/2 w-36 flex justify-between px-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="relative w-3 h-14 bg-cream rounded-full border-b-2 border-mocha/20 shadow-sm">
              <div className="absolute inset-0 bg-gradient-to-b from-transparent to-mocha/10 rounded-full" />
              {!candlesOut && (
                <motion.div
                  animate={{ 
                    scale: [1, 1.3, 1],
                    y: [0, -4, 0],
                    opacity: isBlowing ? 0.4 : 1,
                    rotate: [0, 5, -5, 0]
                  }}
                  transition={{ repeat: Infinity, duration: 0.4 + i * 0.1 }}
                  className="absolute -top-8 left-1/2 -translate-x-1/2 w-5 h-8 bg-orange-500 rounded-full blur-[1px] shadow-[0_0_15px_rgba(249,115,22,0.6)]"
                >
                  <div className="absolute inset-1.5 bg-yellow-200 rounded-full" />
                </motion.div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="h-16 flex items-center justify-center">
        <AnimatePresence>
          {candlesOut && (
            <motion.button
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={onNext}
              className="bg-beige text-dark-bg px-12 py-4 rounded-2xl font-bold text-lg flex items-center gap-3 hover:bg-cream transition-all shadow-2xl"
            >
              See Message <Heart size={24} className="fill-current" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {!candlesOut && (
        <button 
          onClick={() => {
            setCandlesOut(true);
            
            const scalar = 2.5;
            const shapes = [
              confetti.shapeFromText({ text: '🎂', scalar }),
              confetti.shapeFromText({ text: '🎁', scalar }),
              confetti.shapeFromText({ text: '🎈', scalar }),
              confetti.shapeFromText({ text: '✨', scalar }),
              confetti.shapeFromText({ text: '🍰', scalar }),
              confetti.shapeFromText({ text: '🎉', scalar }),
              confetti.shapeFromText({ text: '🎊', scalar }),
              'circle',
              'square'
            ];

            confetti({
              particleCount: 200,
              spread: 90,
              origin: { y: 0.6 },
              colors: [COLORS.mocha, COLORS.beige, '#FFD700', '#FF69B4', '#87CEEB'],
              shapes: shapes as any,
              scalar
            });
          }}
          className="mt-12 text-sm text-mocha/50 hover:text-mocha underline uppercase tracking-[0.2em] font-bold transition-colors"
        >
          (Can't blow? Click here)
        </button>
      )}
    </motion.div>
  );
}

// --- Final Message Component ---

function FinalMessage({ shareId }: { shareId: string | null }) {
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const fullText = "Happy Birthday! May your day be filled with love, joy, and beautiful surprises. You deserve all the happiness in the world. ✨";

  const handleShare = async () => {
    const baseUrl = window.location.href.split('?')[0];
    const url = shareId ? `${baseUrl}?id=${shareId}` : baseUrl;
    const shareData = {
      title: 'A Special Birthday Memory',
      text: 'I created a special birthday memory for you! Check it out.',
      url: url,
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        throw new Error('Native share not available');
      }
    } catch (err) {
      // Fallback to clipboard for ANY error (including cancellation or iframe restrictions)
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (clipErr) {
        console.error('Clipboard fallback failed:', clipErr);
      }
    }
  };

  useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      setText(fullText.slice(0, i));
      i++;
      if (i > fullText.length) clearInterval(interval);
    }, 50);
    return () => clearInterval(interval);
  }, []);

  return (
    <motion.div
      key="message"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="text-center max-w-3xl px-6 sm:px-8 glass p-8 sm:p-16 rounded-[2rem] sm:rounded-[4rem] border border-white/10 shadow-3xl mx-4"
    >
      <motion.div
        animate={{ 
          scale: [1, 1.2, 1],
          rotate: [0, 10, -10, 0]
        }}
        transition={{ repeat: Infinity, duration: 4 }}
        className="inline-block mb-8 sm:mb-12 relative"
      >
        <div className="absolute inset-0 bg-beige/20 blur-2xl rounded-full animate-pulse" />
        <Heart size={60} className="text-beige fill-beige/30 relative z-10 sm:w-[100px] sm:h-[100px]" />
      </motion.div>
      
      <h1 className="font-serif text-2xl sm:text-4xl md:text-6xl mb-8 sm:mb-12 text-beige leading-tight italic tracking-tight">
        {text}
      </h1>
      
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 3 }}
        className="mt-16 flex flex-col items-center gap-8"
      >
        <button 
          onClick={() => window.location.reload()}
          className="group text-mocha flex items-center gap-3 hover:text-beige transition-all uppercase tracking-[0.3em] text-sm font-bold"
        >
          <RotateCcw size={20} className="group-hover:rotate-180 transition-transform duration-500" /> 
          Create another memory
        </button>
        
        <div className="flex gap-6 relative">
           <motion.button 
             onClick={handleShare}
             whileHover={{ scale: 1.1, backgroundColor: 'rgba(255,255,255,0.1)' }}
             className="p-4 rounded-2xl glass text-beige transition-all border border-white/10 flex items-center gap-3"
           >
             <Share2 size={24} />
             <span className="text-xs font-bold uppercase tracking-widest">Share Memory</span>
           </motion.button>
           
           <AnimatePresence>
             {copied && (
               <motion.div
                 initial={{ opacity: 0, y: 10 }}
                 animate={{ opacity: 1, y: 0 }}
                 exit={{ opacity: 0, y: 10 }}
                 className="absolute -top-12 left-1/2 -translate-x-1/2 bg-beige text-dark-bg px-4 py-2 rounded-lg text-xs font-bold shadow-xl whitespace-nowrap"
               >
                 Link copied to clipboard!
               </motion.div>
             )}
           </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  );
}
