# Water Timer

A shared server-side timer app for **ROSIE** and **ADAM**.

- **ROSIE** is the vehicle
- **ADAM** is the vertical profiling float
- resets require a password *and* a justification
- state is shared on the server so everyone sees the same timer data

## Live deployment

The app is deployed on this server behind **nginx** at:

- https://server.voss.industries/rov-water/

nginx proxies requests to the local Python backend, which serves both the UI and the `/api` endpoints.

## Local development

From the repo root:

```bash
cd rov-water
python3 rov-water/server.py
```

Then open the app in your browser at the local server URL shown by the script.

## Notes

- The backend persists shared timer state on disk.
- Reset history stores the justification text.
- The project is intended to be deployed as a normal server app, not GitHub Pages — Pages cannot run the backend.
