'use client';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { Video, PhoneCall, PhoneOff, User, Mic, MicOff, Camera, CameraOff } from 'lucide-react';


interface IncomingCallData {
    offer: RTCSessionDescriptionInit;
    callerId: string;
}

type CallStatus = 
    | 'Idle' 
    | 'Connecting...' 
    | 'Incoming Call' 
    | 'Waiting for answer...' 
    | 'Connected' 
    | 'Call Ended' 
    | 'Media Access Denied'
    | 'Call Failed';

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  ],
};

const SOCKET_SERVER_URL = 'http://localhost:4000'; 
const socket: Socket = io(SOCKET_SERVER_URL, {
});

class PeerConnectionManager {
  private socket: Socket;
  private localStream: MediaStream;
  private setCallStatus: React.Dispatch<React.SetStateAction<CallStatus>>;
  private updateRemoteStream: React.Dispatch<React.SetStateAction<MediaStream | null>>;
  private pc: RTCPeerConnection | null = null;
  private isInitiator: boolean = false;
  private remotePeerId: string | null = null;

  constructor(
    socket: Socket, 
    localStream: MediaStream, 
    setCallStatus: React.Dispatch<React.SetStateAction<CallStatus>>, 
    updateRemoteStream: React.Dispatch<React.SetStateAction<MediaStream | null>>
  ) {
    this.socket = socket;
    this.localStream = localStream;
    this.setCallStatus = setCallStatus;
    this.updateRemoteStream = updateRemoteStream;
  }

  initPeerConnection(isInitiator: boolean, remotePeerId: string): void {
    this.isInitiator = isInitiator;
    this.remotePeerId = remotePeerId;

    if (this.pc) {
        console.warn('Existing peer connection found, closing it first.');
        this.pc.close();
    }

    this.pc = new RTCPeerConnection(ICE_SERVERS);
    this.setCallStatus('Connecting...');

    this.localStream.getTracks().forEach((track: MediaStreamTrack) => {
        if (this.pc) {
            this.pc.addTrack(track, this.localStream);
        }
    });

    this.pc.ontrack = (event: RTCTrackEvent) => {
      console.log('Received remote track.');
      this.updateRemoteStream(event.streams[0]);
    };

    this.pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate && this.remotePeerId) {
        console.log('Sending ICE candidate to peer:', event.candidate);
        this.socket.emit('ice-candidate', {
          candidate: event.candidate,
          targetId: this.remotePeerId,
          type: 'candidate',
        });
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (!this.pc) return;
      console.log('ICE connection state:', this.pc.iceConnectionState);
      if (this.pc.iceConnectionState === 'connected') {
        this.setCallStatus('Connected');
      } else if (this.pc.iceConnectionState === 'disconnected' || this.pc.iceConnectionState === 'failed') {
        this.setCallStatus('Call Ended');
        this.close();
      }
    };
  }

  async createOffer(): Promise<void> {
    if (!this.pc || !this.remotePeerId) return;

    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      
      console.log('Sending offer to peer:', this.remotePeerId);
      this.socket.emit('call-user', {
        offer: this.pc.localDescription,
        targetId: this.remotePeerId,
        type: 'offer',
      });
      this.setCallStatus('Waiting for answer...');
    } catch (error) {
      console.error('Error creating or sending offer:', error);
      this.setCallStatus('Call Failed');
    }
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc || !this.remotePeerId) return;

    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);

      console.log('Sending answer back to caller:', this.remotePeerId);
      this.socket.emit('answer-call', {
        answer: this.pc.localDescription,
        targetId: this.remotePeerId,
        type: 'answer',
      });
      this.setCallStatus('Connected');
    } catch (error) {
      console.error('Error handling offer or creating answer:', error);
      this.setCallStatus('Call Failed');
    }
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) return;
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
      console.log('Answer received and set.');
    } catch (error) {
      console.error('Error handling answer:', error);
      this.setCallStatus("Call Failed");
    }
  }
  
  async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc) return;
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      console.log('ICE candidate added.');
    } catch (error) {
      console.error('Error adding ICE candidate:', error);
    }
  }

  close(): void {
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    this.remotePeerId = null;
    this.setCallStatus('Idle');
    this.updateRemoteStream(null);
  }
}

const WebRTCCall = () => {
  const [currentId, setCurrentId] = useState<string>('');
  const [targetId, setTargetId] = useState<string>('');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [callStatus, setCallStatus] = useState<CallStatus>('Idle'); 
  const [incomingCallData, setIncomingCallData] = useState<IncomingCallData | null>(null); 
  const [isMicMuted, setIsMicMuted] = useState<boolean>(false);
  const [isCamOff, setIsCamOff] = useState<boolean>(false);
  
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const peerManagerRef = useRef<PeerConnectionManager | null>(null);

  const getMedia = useCallback(async (): Promise<MediaStream | null> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      return stream;
    } catch (err) {
      console.error('Failed to get local media:', err);
      setCallStatus('Media Access Denied');
      return null;
    }
  }, []);

  useEffect(() => {
    socket.connect();

    socket.on('me', (id: string) => {
      setCurrentId(id);
      console.log('My Socket ID:', id);
    });

    socket.on('call-made', (data: { offer: RTCSessionDescriptionInit, callerId: string }) => {
        const { offer, callerId } = data;
        console.log('Incoming call offer from:', callerId);
        setIncomingCallData({ offer, callerId });
        setCallStatus('Incoming Call');
    });

    socket.on('answer-made', async (data: { answer: RTCSessionDescriptionInit }) => {
        const { answer } = data;
        console.log('Answer received from peer.');
        if (peerManagerRef.current) {
            await peerManagerRef.current.handleAnswer(answer);
        }
    });

    socket.on('ice-candidate', async (data: { candidate: RTCIceCandidateInit }) => {
        if (peerManagerRef.current && data.candidate) {
            await peerManagerRef.current.handleIceCandidate(data.candidate);
        }
    });

    return () => {
      socket.off('me');
      socket.off('call-made');
      socket.off('answer-made');
      socket.off('ice-candidate');
      socket.disconnect();
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  useEffect(() => {
    if (localStream && localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteStream && remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);



  const startCall = async (): Promise<void> => {
    if (!targetId) {
      console.error("Please enter a User ID to call.");
      setCallStatus('Idle');
      return;
    }
    if (callStatus === 'Connected' || callStatus === 'Waiting for answer...') return;
    
    const stream = localStream || await getMedia();
    if (!stream) return;

    const manager = new PeerConnectionManager(socket, stream, setCallStatus, setRemoteStream);
    peerManagerRef.current = manager;
    manager.initPeerConnection(true, targetId);
    
    await manager.createOffer();
  };
  
  const answerCall = async (): Promise<void> => {
    if (!incomingCallData || callStatus !== 'Incoming Call') return;

    const stream = localStream || await getMedia();
    if (!stream) return;

    const manager = new PeerConnectionManager(socket, stream, setCallStatus, setRemoteStream);
    peerManagerRef.current = manager;
    manager.initPeerConnection(false, incomingCallData.callerId);

    await manager.handleOffer(incomingCallData.offer);

    setIncomingCallData(null);
  };

  const endCall = (): void => {
    if (peerManagerRef.current) {
      peerManagerRef.current.close();
      peerManagerRef.current = null;
    }
    
    const peerId = targetId || incomingCallData?.callerId;
    if (peerId) {
        socket.emit('call-end', { targetId: peerId });
    }
    
    setCallStatus('Call Ended');
    setRemoteStream(null);
    setTargetId('');
    setIncomingCallData(null);
  };
  
  const toggleMic = (): void => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMicMuted(!audioTrack.enabled);
      }
    }
  };
  
  const toggleCam = (): void => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsCamOff(!videoTrack.enabled);
      }
    }
  };


  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-white p-4 sm:p-8">
      <div className="max-w-4xl mx-auto bg-white dark:bg-gray-800 shadow-xl rounded-xl p-6 space-y-6">
        <h1 className="text-3xl font-extrabold text-center text-indigo-600 dark:text-indigo-400">
          WebRTC Call Interface (React + Socket.IO)
        </h1>
        
        <div className="flex justify-between items-center bg-indigo-50 dark:bg-gray-700 p-3 rounded-lg">
          <span className="font-medium">Your ID: </span>
          <code className="text-sm font-mono bg-white dark:bg-gray-600 p-1 rounded break-all">{currentId || 'Connecting...'}</code>
        </div>

        <div className="text-center">
            <span className={`px-4 py-1 rounded-full text-sm font-semibold 
                ${callStatus === 'Connected' ? 'bg-green-100 text-green-700' : 
                  callStatus === 'Incoming Call' ? 'bg-yellow-100 text-yellow-700 animate-pulse' : 
                  callStatus === 'Call Ended' ? 'bg-red-100 text-red-700' : 
                  callStatus === 'Call Failed' ? 'bg-red-500 text-white' : // Style the new status
                  'bg-gray-200 text-gray-600'}`}>
                Status: {callStatus}
            </span>
        </div>

        {/* Video Streams Section */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          
          {/* Local Video */}
          <div className="relative bg-gray-200 dark:bg-gray-700 rounded-lg overflow-hidden aspect-video shadow-md">
            <video 
              ref={localVideoRef} 
              autoPlay 
              muted 
              playsInline 
              className="w-full h-full object-cover rounded-lg"
            />
            {(!localStream || isCamOff) && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900 bg-opacity-80 text-white">
                    <User size={48} />
                    <p className="mt-2 text-sm">Local Video Off</p>
                </div>
            )}
            <span className="absolute bottom-2 left-2 bg-black bg-opacity-50 text-white text-xs px-2 py-0.5 rounded-full">You</span>
          </div>

          {/* Remote Video */}
          <div className="relative bg-gray-200 dark:bg-gray-700 rounded-lg overflow-hidden aspect-video shadow-md border-2 border-dashed border-gray-400">
            <video 
              ref={remoteVideoRef} 
              autoPlay 
              playsInline 
              className="w-full h-full object-cover rounded-lg"
            />
            {!remoteStream && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-500">
                    <Video size={48} />
                    <p className="mt-2 text-sm">Remote Peer Awaits</p>
                </div>
            )}
            {remoteStream && (
                <span className="absolute bottom-2 left-2 bg-black bg-opacity-50 text-white text-xs px-2 py-0.5 rounded-full">Peer</span>
            )}
          </div>
        </div>

        {/* Controls Section */}
        <div className="space-y-4">
          
          {/* Call Input and Button */}
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              placeholder="Enter User ID to Call"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="flex-grow p-3 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-indigo-500 focus:border-indigo-500 dark:bg-gray-700 dark:text-white"
            />
            <button
              onClick={startCall}
              disabled={callStatus === 'Connected' || callStatus === 'Waiting for answer...'}
              className="flex items-center justify-center w-full sm:w-auto px-6 py-3 bg-indigo-600 text-white font-semibold rounded-lg shadow-md hover:bg-indigo-700 transition duration-150 disabled:bg-gray-400"
            >
              <PhoneCall size={20} className="mr-2" />
              Call
            </button>
          </div>
          
          {/* Mid-Call Controls and Hangup */}
          <div className="flex justify-center items-center space-x-4">
            
            {/* Mic Toggle */}
            <button
              onClick={toggleMic}
              disabled={!localStream}
              className={`p-3 rounded-full shadow-md transition duration-150 
                ${isMicMuted ? 'bg-red-500 hover:bg-red-600 text-white' : 'bg-gray-200 hover:bg-gray-300 dark:bg-gray-600 dark:hover:bg-gray-500 dark:text-white'}
                disabled:bg-gray-400`}
              aria-label={isMicMuted ? "Unmute Microphone" : "Mute Microphone"}
            >
              {isMicMuted ? <MicOff size={24} /> : <Mic size={24} />}
            </button>
            
            {/* Camera Toggle */}
            <button
              onClick={toggleCam}
              disabled={!localStream}
              className={`p-3 rounded-full shadow-md transition duration-150 
                ${isCamOff ? 'bg-red-500 hover:bg-red-600 text-white' : 'bg-gray-200 hover:bg-gray-300 dark:bg-gray-600 dark:hover:bg-gray-500 dark:text-white'}
                disabled:bg-gray-400`}
              aria-label={isCamOff ? "Turn Camera On" : "Turn Camera Off"}
            >
              {isCamOff ? <CameraOff size={24} /> : <Camera size={24} />}
            </button>

            {/* Hangup Button */}
            <button
              onClick={endCall}
              disabled={callStatus === 'Idle' || callStatus === 'Call Ended'}
              className="p-4 rounded-full bg-red-600 text-white shadow-lg hover:bg-red-700 transition duration-150 disabled:bg-red-300"
              aria-label="End Call"
            >
              <PhoneOff size={24} />
            </button>
          </div>

          {/* Incoming Call UI */}
          {incomingCallData && callStatus === 'Incoming Call' && (
            <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex items-center justify-center">
              <div className="bg-white dark:bg-gray-800 p-8 rounded-xl shadow-2xl text-center space-y-4">
                <h2 className="text-2xl font-bold text-red-600">Incoming Call!</h2>
                <p className="text-lg">From User ID: <code className="font-mono text-indigo-600 dark:text-indigo-400">{incomingCallData.callerId}</code></p>
                <div className="flex justify-center space-x-4">
                  <button
                    onClick={answerCall}
                    className="flex items-center px-6 py-3 bg-green-600 text-white font-semibold rounded-lg shadow-md hover:bg-green-700 transition duration-150"
                  >
                    <PhoneCall size={20} className="mr-2" />
                    Answer
                  </button>
                  <button
                    onClick={() => { setIncomingCallData(null); setCallStatus('Idle'); }}
                    className="flex items-center px-6 py-3 bg-red-600 text-white font-semibold rounded-lg shadow-md hover:bg-red-700 transition duration-150"
                  >
                    <PhoneOff size={20} className="mr-2" />
                    Reject
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default WebRTCCall;