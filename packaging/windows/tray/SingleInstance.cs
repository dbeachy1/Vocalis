using System;
using System.Threading;

namespace VocalisSatelliteTray
{
    // One icon per install and user: a named mutex, created owned so that it is released (or abandoned) exactly when
    // the owning thread or process ends. The thread that acquires it must be the one that releases it (the program's
    // main thread). An abandoned mutex is how "--exit" learns that the running copy crashed instead of closing.
    internal sealed class SingleInstance : IDisposable
    {
        private Mutex mutex;
        private bool owned;

        private SingleInstance(Mutex mutex)
        {
            this.mutex = mutex;
            owned = true;
        }

        // Null when another copy already holds the name.
        public static SingleInstance TryAcquire(string name)
        {
            bool createdNew;
            var mutex = new Mutex(true, name, out createdNew);
            if (!createdNew)
            {
                mutex.Dispose();
                return null;
            }
            return new SingleInstance(mutex);
        }

        // The normal ending: the mutex is released before the process ends, so a waiting "--exit" sees a clean close.
        public void Release()
        {
            if (!owned) return;
            owned = false;
            mutex.ReleaseMutex();
        }

        public void Dispose()
        {
            if (mutex == null) return;
            Release();
            mutex.Dispose();
            mutex = null;
        }
    }
}
