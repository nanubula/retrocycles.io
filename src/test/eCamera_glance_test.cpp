/*
SPDX-License-Identifier: GPL-2.0-or-later

This file is part of the browser and platform additions to Armagetron Advanced.

This program is free software; you can redistribute it and/or
modify it under the terms of the GNU General Public License
as published by the Free Software Foundation; either version 2
of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.
*/

// Camera glance options (CAMERA_GLANCE_SNAP, _HOLD, _TAKEOVER, _FORWARD_SNAP and
// the GLANCE_FORWARD action): drives eCamera::Timestep frame by frame with a cycle
// that turns, presses the glance keys through eCamera::Act like the player does and
// measures the view direction (dir turned by the glance, as Render uses it).
// AA_GLANCE_REPORT=1 in the environment prints the measurements per combination.

#include "doctest.h"
#include "eCamera.h"
#include "eGameObject.h"
#include "eGrid.h"
#include "eTimer.h"
#include "eAdvWall.h"
#include "gWall.h"
#include "ePlayer.h"
#include "rScreen.h"
#include "rViewport.h"
#include "tConfiguration.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <sstream>
#include <string>

namespace
{
const REAL frameTime = 1/60.0;

void SetConf( char const * line )
{
    tCurrentAccessLevel level( tAccessLevel_Owner, true );
    std::istringstream s( line );
    tConfItemBase::LoadLine( s );
}

// signed angle from a to b in degrees
REAL AngleDeg( eCoord a, eCoord b )
{
    return atan2( a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y ) * 180 / M_PI;
}

class GlanceCycle : public eStackGameObject
{
public:
    GlanceCycle( eGrid * grid, eCoord const & p, eCoord const & d, eFace * face )
        : eStackGameObject( grid, p, d, face ), lastDir_( d )
    {
    }

    bool Alive() const override { return true; }
    void Kill() override {}
    REAL Speed() const override { return 10; }
    // like gCycle: the direction before the last turn
    eCoord LastDirection() const override { return lastDir_; }

    // left: counterclockwise, the side glanceSmooth > 0 looks to
    void Turn( int side )
    {
        lastDir_ = dir;
        dir = dir.Turn( eCoord( 0, side ) );
    }
    void Move( REAL ts ) { pos = pos + dir * ( Speed() * ts ); }

private:
    eCoord lastDir_;
};

class GlanceCamera : public eCamera
{
public:
    GlanceCamera( eGrid * grid, rViewport * vp, eCamMode m )
        : eCamera( grid, vp, nullptr, LocalPlayer( m ), m )
    {
    }

    // the first local player with its default camera settings, starting in the given mode
    static ePlayer * LocalPlayer( eCamMode m )
    {
        ePlayer * p = ePlayer::PlayerConfig( 0 );
        p->startCamera = m;
        return p;
    }

    eCoord View() const
    {
        eCoord v = dir.Turn( glanceDir_ );
        v.Normalize();
        return v;
    }

    void Back( bool down )    { Act( &se_glanceBack, down ? 1 : 0 ); }
    void Left( bool down )    { Act( &se_glanceLeft, down ? 1 : 0 ); }
    void Forward( bool down ) { Act( &se_glanceForward, down ? 1 : 0 ); }
    void LookLeft()           { Act( &se_lookLeft, 10 ); }

    void Turn( int side )
    {
        Act( reinterpret_cast< uActionCamera * >( side > 0 ? &eGameObject::se_turnLeft : &eGameObject::se_turnRight ), 1 );
    }
    bool Glancing() const { return glancingBack || glancingLeft || glancingForward; }
    bool HoldReturning() const { return returnGlanceRequest || smartGlanceReturn; }
};

// one world: a grid, a cycle and a camera in the given mode
struct GlanceWorld
{
    tJUST_CONTROLLED_PTR< eGrid > grid;
    rViewport viewport;
    GlanceCycle * cycle;
    GlanceCamera * camera;

    explicit GlanceWorld( eCamMode mode )
        : viewport( 0, 0, 1, 1 )
    {
        grid = new eGrid();
        grid->Create();

        // a square rim, as a map draws it: the smart cameras clamp to its bounds
        eCoord const corners[] = { eCoord( -500, -500 ), eCoord( 500, -500 ), eCoord( 500, 500 ), eCoord( -500, 500 ) };
        ePoint * p = grid->Insert( corners[0] );
        for ( int i = 1; i <= 4; ++i )
        {
            tJUST_CONTROLLED_PTR< gWallRim > rim = tNEW( gWallRim )( grid, 4 );
            p = grid->DrawLine( p, corners[ i % 4 ], rim, 0 );
        }
        eWallRim::UpdateBounds();

        eCoord start( 0, 0 );
        cycle = new GlanceCycle( grid, start, eCoord( 1, 0 ), grid->FindSurroundingFace( start ) );
        grid->AddGameObjectInteresting( cycle );
        camera = new GlanceCamera( grid, &viewport, mode );
        Steps( 120 );
    }

    ~GlanceWorld()
    {
        delete camera;
        grid->RemoveGameObjectInteresting( cycle );
        delete cycle;
        grid->Clear();
        eWallRim::UpdateBounds();
    }

    // one frame; returns the view change in degrees
    REAL Step()
    {
        eCoord before = camera->View();
        cycle->Move( frameTime );
        camera->Timestep( frameTime );
        return fabs( AngleDeg( before, camera->View() ) );
    }

    REAL Steps( int n )
    {
        REAL worst = 0;
        for ( int i = 0; i < n; ++i )
        {
            REAL d = Step();
            if ( d > worst )
                worst = d;
        }
        return worst;
    }

    void TurnCycle( int side )
    {
        camera->Turn( side );
        cycle->Turn( side );
    }

    // view relative to the driving direction, degrees
    REAL ViewToCycle() const { return AngleDeg( cycle->Direction(), camera->View() ); }
};

struct GlanceResult
{
    REAL viewHeld;        // view to driving direction after the turn, key still down
    REAL releaseStep;     // view change on the release frame
    REAL afterStep;       // largest view change per frame after the release frame
    REAL endToCycle;      // view to driving direction 1 s after release
    bool keyStillDown;    // glance flag still set after the turn (no takeover)
};

enum GlanceKind { GLANCE_BACK, GLANCE_LEFT, GLANCE_FORWARD_KEY };

void Press( GlanceCamera & cam, GlanceKind kind, bool down )
{
    switch ( kind )
    {
    case GLANCE_BACK: cam.Back( down ); break;
    case GLANCE_LEFT: cam.Left( down ); break;
    case GLANCE_FORWARD_KEY: cam.Forward( down ); break;
    }
}

// press the glance, hold it 0.3 s, turn the cycle to the given side, hold 0.4 s, release
GlanceResult GlanceAndTurn( eCamMode mode, GlanceKind kind, int turnSide )
{
    GlanceWorld w( mode );
    GlanceResult r;
    Press( *w.camera, kind, true );
    w.Steps( 18 );
    w.TurnCycle( turnSide );
    w.Steps( 24 );
    r.viewHeld = w.ViewToCycle();
    r.keyStillDown = w.camera->Glancing();
    Press( *w.camera, kind, false );
    r.releaseStep = w.Step();
    r.afterStep = w.Steps( 60 );
    r.endToCycle = w.ViewToCycle();
    return r;
}

// press the glance and release it one frame later; largest view change per frame
REAL Tap( eCamMode mode, GlanceKind kind )
{
    GlanceWorld w( mode );
    Press( *w.camera, kind, true );
    REAL worst = w.Step();
    Press( *w.camera, kind, false );
    REAL after = w.Steps( 60 );
    REAL end = fabs( w.ViewToCycle() );
    CHECK( end < 5 );
    return after > worst ? after : worst;
}

struct Combination
{
    bool snap, hold, takeover;
};

void Apply( Combination const & c )
{
    SetConf( c.snap ? "CAMERA_GLANCE_SNAP 1" : "CAMERA_GLANCE_SNAP 0" );
    SetConf( c.hold ? "CAMERA_GLANCE_HOLD 1" : "CAMERA_GLANCE_HOLD 0" );
    SetConf( c.takeover ? "CAMERA_GLANCE_TAKEOVER 1" : "CAMERA_GLANCE_TAKEOVER 0" );
}

bool Report()
{
    char const * r = getenv( "AA_GLANCE_REPORT" );
    return r && *r && *r != '0';
}

char const * ModeName( eCamMode mode )
{
    switch ( mode )
    {
    case CAMERA_IN: return "internal";
    case CAMERA_CUSTOM: return "custom";
    case CAMERA_SMART: return "smart";
    default: return "?";
    }
}

char const * KindName( GlanceKind kind )
{
    switch ( kind )
    {
    case GLANCE_BACK: return "back";
    case GLANCE_LEFT: return "left";
    case GLANCE_FORWARD_KEY: return "forward";
    }
    return "?";
}

// a running game timer, a screen size and the default glance settings; restored afterwards
struct GlanceSetup
{
    eCamMode startCamera;
    int screenWidth, screenHeight;

    GlanceSetup()
        : startCamera( ePlayer::PlayerConfig( 0 )->startCamera ),
          screenWidth( sr_screenWidth ), screenHeight( sr_screenHeight )
    {
        se_MakeGameTimer();
        se_ResetGameTimer( 100 );
        // rViewport::UpDownFOV divides by the screen size
        sr_screenWidth = 800;
        sr_screenHeight = 600;
    }

    ~GlanceSetup()
    {
        Apply( Combination{ false, false, true } );
        ePlayer::PlayerConfig( 0 )->startCamera = startCamera;
        sr_screenWidth = screenWidth;
        sr_screenHeight = screenHeight;
        se_KillGameTimer();
    }
};
}

TEST_SUITE( "eCamera glance" )
{
    TEST_CASE( "glance options on the internal, custom and smart cameras" )
    {
        GlanceSetup setup;
        eCamMode const modes[] = { CAMERA_IN, CAMERA_CUSTOM, CAMERA_SMART };
        GlanceKind const kinds[] = { GLANCE_BACK, GLANCE_LEFT, GLANCE_FORWARD_KEY };

        if ( Report() )
            printf( "camera   glance  S H T | key down after turn | held view | release step | worst step after | view 1 s after | tap worst step\n" );

        for ( int bits = 0; bits < 8; ++bits )
        {
            Combination c = { ( bits & 1 ) != 0, ( bits & 2 ) != 0, ( bits & 4 ) != 0 };
            Apply( c );
            for ( eCamMode mode : modes )
            {
                for ( GlanceKind kind : kinds )
                {
                    CAPTURE( ModeName( mode ) );
                    CAPTURE( KindName( kind ) );
                    CAPTURE( c.snap );
                    CAPTURE( c.hold );
                    CAPTURE( c.takeover );

                    // turn toward the glance (left), so TAKEOVER can end it
                    GlanceResult r = GlanceAndTurn( mode, kind, 1 );
                    REAL tap = Tap( mode, kind );

                    if ( Report() )
                        printf( "%-8s %-7s %d %d %d | %-19s | %9.1f | %12.1f | %16.1f | %14.1f | %14.1f\n",
                                ModeName( mode ), KindName( kind ), c.snap, c.hold, c.takeover,
                                r.keyStillDown ? "yes" : "no", r.viewHeld, r.releaseStep, r.afterStep, r.endToCycle, tap );

                    // TAKEOVER ends a back or left glance on a turn to the left; never glance forward
                    bool takenOver = kind != GLANCE_FORWARD_KEY && c.takeover;
                    CHECK( r.keyStillDown == !takenOver );

                    // HOLD keeps the glance on the world direction it started on: after a left
                    // turn the view is 90 degrees further right than without hold
                    if ( !takenOver )
                    {
                        REAL expected = kind == GLANCE_BACK ? 180 : kind == GLANCE_LEFT ? 90 : 0;
                        if ( c.hold )
                            expected -= 90;
                        CHECK( fabs( remainder( r.viewHeld - expected, 360 ) ) < 5 );
                    }

                    // no snap on release: only glance back flips at once, as in 0.2.9; the
                    // return after a held glance runs at GLANCE_SPEED (45 degrees, then less)
                    if ( kind != GLANCE_BACK )
                        CHECK( r.releaseStep < 50 );
                    CHECK( r.afterStep < 50 );
                    if ( kind != GLANCE_BACK )
                        CHECK( tap < 50 );

                    // every glance ends looking where the cycle drives; a smart camera that
                    // took over a back glance keeps that view and swings round slowly (0.2.9)
                    if ( !( takenOver && mode == CAMERA_SMART && kind == GLANCE_BACK ) )
                        CHECK( fabs( r.endToCycle ) < 5 );
                }
            }
        }
    }

    TEST_CASE( "smart camera hold release eases out" )
    {
        GlanceSetup setup;
        Apply( Combination{ false, true, false } );

        // glance left, turn right twice: the hold adds 180 degrees to the glance
        GlanceWorld w( CAMERA_SMART );
        w.camera->Left( true );
        w.Steps( 30 );
        w.TurnCycle( -1 );
        w.Steps( 20 );
        w.TurnCycle( -1 );
        w.Steps( 20 );
        w.camera->Left( false );
        REAL release = w.Step();
        CHECK( w.camera->HoldReturning() );
        REAL after = w.Steps( 60 );
        if ( Report() )
            printf( "smart hold, left glance, two turns away: release step %.1f, worst step after %.1f, view 1 s after %.1f\n",
                    release, after, w.ViewToCycle() );

        // the extra 180 degrees go away over about 15 frames, not in one
        CHECK( release < 45 );
        CHECK( after < 65 );
        CHECK( fabs( w.ViewToCycle() ) < 5 );
        CHECK( !w.camera->HoldReturning() );
    }

    TEST_CASE( "a glance started while the smart camera is moved by hand holds the new direction" )
    {
        GlanceSetup setup;
        Apply( Combination{ false, true, false } );

        GlanceWorld w( CAMERA_SMART );
        w.camera->Back( true );
        w.Steps( 10 );

        // move the camera by hand (userCameraControl over .25 turns the smart hold code off)
        // from before the release until after the next glance starts, so the hold code
        // never sees the release
        for ( int i = 0; i < 10; ++i )
        {
            w.camera->LookLeft();
            w.Step();
        }
        w.camera->Back( false );
        for ( int i = 0; i < 30; ++i )
        {
            w.camera->LookLeft();
            w.Step();
        }
        w.TurnCycle( 1 );
        for ( int i = 0; i < 30; ++i )
        {
            w.camera->LookLeft();
            w.Step();
        }
        w.camera->Back( true );
        for ( int i = 0; i < 5; ++i )
        {
            w.camera->LookLeft();
            w.Step();
        }

        // the hold starts when the hand control has died down, on the direction of then
        w.Steps( 120 );
        REAL view = w.ViewToCycle();
        w.camera->Back( false );
        w.Steps( 60 );
        if ( Report() )
            printf( "smart hold, glance started during hand control: view %.1f (expect about 180)\n", view );
        CHECK( fabs( fabs( view ) - 180 ) < 20 );
    }
}
