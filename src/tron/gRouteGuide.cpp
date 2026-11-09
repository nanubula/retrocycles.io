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

#include "gRouteGuide.h"

#include "gCycle.h"
#include "eCamera.h"
#include "eGrid.h"
#include "ePlayer.h"
#include "eTimer.h"
#include "nNetObject.h"
#include "nNetwork.h"
#include "rGL.h"
#include "rRender.h"
#include "rScreen.h"
#include "tSysTime.h"

#include <algorithm>
#include <cmath>

// *******************************************************************************
// *
// *	the look (map units, seconds; matched to the design preview)
// *
// *******************************************************************************

// the window: the next AHEAD_TIME seconds at the cycle's speed, at least AHEAD_MIN
// units, the far end fading over FAR_FADE; the route's last END_FADE units fade out;
// the line fades in over the first NEAR_FADE units ahead of the cycle
static REAL const sg_routeAheadTime = 3;
static REAL const sg_routeAheadMin  = 45;
static REAL const sg_routeFarFade   = 18;
static REAL const sg_routeEndFade   = 25;
static REAL const sg_routeNearFade  = 3;

// one pulse at a time: it leaves the cycle, runs PULSE_RANGE ahead at PULSE_SPEED,
// fading as (1 - d/range)^1.2, and the next one leaves PULSE_GAP later
static REAL const sg_routePulseSpeed = 75;
static REAL const sg_routePulseRange = 60;
static REAL const sg_routePulseGap   = .5;
static REAL const sg_routePulseWidth = 7;

// chevrons: groups CHEVRON_EVERY apart on long stretches, CHEVRON_GAP apart in a group
static REAL const sg_routeChevronGap   = 1.7;
static REAL const sg_routeChevronEvery = 24;
static REAL const sg_routeChevronSize  = 1.15;

// alpha at rest and at the pulse's peak (the chevrons draw on top of the walls)
static REAL const sg_routeLineAlpha    = .24;
static REAL const sg_routeChevronAlpha = .3;

// widths on the floor: the line, how much the pulse widens it, a chevron's stroke
static REAL const sg_routeLineWidth    = .6;
static REAL const sg_routePulseWiden   = .45;
static REAL const sg_routeChevronWidth = .32 * sg_routeChevronSize;

// the soft halo beside the line, so it glows without the bloom pass (Low): width
// as a multiple of the line's and its alpha relative to the line's
static REAL const sg_routeHaloWidth = 4;
static REAL const sg_routeHaloAlpha = .3;

// what draws on top of the walls shows only ahead of the own cycle: it fades out from
// CYCLE_CLEAR + CYCLE_FADE units ahead to CYCLE_CLEAR, so a stretch that runs back past
// the cycle (towards the camera) does not cover it
static REAL const sg_routeCycleClear = 3;
static REAL const sg_routeCycleFade  = 4;

// when the guide goes: this far off the route for this long, or the round this old
static REAL const sg_routeOffDistance = 12;
static REAL const sg_routeOffTime     = 1;
static REAL const sg_routeRoundTime   = 30;

// how long a guide waits for its cycle to appear (system time)
static double const sg_routeWaitForCycle = 5;

// the gold, #ffb800
static REAL const sg_routeR = 1, sg_routeG = .722, sg_routeB = 0;

// *******************************************************************************
// *
// *	gRoutePath
// *
// *******************************************************************************

gRoutePath::gRoutePath( std::vector< eCoord > const & corners )
    : corners_( corners )
{
    REAL along = 0;
    for ( size_t i = 0; i < corners_.size(); ++i )
    {
        if ( i > 0 )
            along += ( corners_[i] - corners_[i-1] ).Norm();
        starts_.push_back( along );
    }
}

eCoord gRoutePath::SegmentDirection( int i ) const
{
    REAL const len = SegmentLength( i );
    if ( len <= 0 )
        return eCoord( 0, 0 );
    return ( corners_[i+1] - corners_[i] ) * ( 1 / len );
}

eCoord gRoutePath::PointAt( REAL along ) const
{
    if ( corners_.empty() )
        return eCoord( 0, 0 );
    if ( along <= 0 || Segments() < 1 )
        return corners_.front();
    for ( int i = 0; i < Segments(); ++i )
    {
        if ( along <= starts_[i+1] )
            return corners_[i] + SegmentDirection( i ) * ( along - starts_[i] );
    }
    return corners_.back();
}

REAL gRoutePath::Advance( REAL progress, eCoord const & pos, eCoord const & dir, REAL lookahead, REAL & off ) const
{
    // a segment that runs against the cycle counts as this much further away, and
    // each unit ahead of the progress point as this much
    static REAL const againstPenalty = 4;
    static REAL const aheadPenalty = .05;

    REAL const dirLen = dir.Norm();
    REAL best = progress, bestCost = -1;
    off = ( pos - PointAt( progress ) ).Norm();

    for ( int i = 0; i < Segments(); ++i )
    {
        REAL const start = starts_[i], len = SegmentLength( i );
        if ( start + len < progress || len <= 0 )
            continue;
        if ( start > progress + lookahead )
            break;

        eCoord const d = SegmentDirection( i );
        REAL along = start + std::min( len, std::max( REAL( 0 ), eCoord::F( pos - corners_[i], d ) ) );
        along = std::max( along, progress );
        REAL const dist = ( pos - ( corners_[i] + d * ( along - start ) ) ).Norm();

        REAL cost = dist + aheadPenalty * ( along - progress );
        if ( dirLen > 0 && eCoord::F( dir, d ) < -.5 * dirLen )
            cost += againstPenalty;

        if ( bestCost < 0 || cost < bestCost )
        {
            bestCost = cost;
            best = along;
            off = dist;
        }
    }

    return std::max( best, progress );
}

std::vector< gRoutePath::Chevron > gRoutePath::Chevrons() const
{
    std::vector< Chevron > out;
    for ( int i = 0; i < Segments(); ++i )
    {
        REAL const len = SegmentLength( i );

        // as many as the stretch has room for
        int const count = len >= 14 ? 4 : len >= 10 ? 3 : len >= 6 ? 2 : 0;
        if ( count == 0 )
            continue;

        // one group in the middle of a short stretch, else one every 24 units from
        // 12 units in, up to 8 units before the end
        std::vector< REAL > centres;
        if ( len < 30 )
            centres.push_back( len / 2 );
        else
            for ( REAL c = 12; c <= len - 8; c += sg_routeChevronEvery )
                centres.push_back( c );

        eCoord const d = SegmentDirection( i );
        for ( size_t g = 0; g < centres.size(); ++g )
        {
            for ( int j = 0; j < count; ++j )
            {
                REAL const offset = centres[g] + ( j - ( count - 1 ) * .5f ) * sg_routeChevronGap;
                Chevron chevron;
                chevron.along = starts_[i] + offset;
                chevron.pos = corners_[i] + d * offset;
                chevron.dir = d;
                out.push_back( chevron );
            }
        }
    }
    return out;
}

// *******************************************************************************
// *
// *	gRouteGuideLook
// *
// *******************************************************************************

REAL gRouteGuideLook::WindowEnd( REAL progress, REAL speed )
{
    return progress + std::max( sg_routeAheadMin, speed * sg_routeAheadTime );
}

REAL gRouteGuideLook::PulseFront( REAL t )
{
    REAL const period = sg_routePulseRange / sg_routePulseSpeed + sg_routePulseGap;
    if ( t < 0 )
        t = 0;
    return std::fmod( t, period ) * sg_routePulseSpeed;
}

REAL gRouteGuideLook::PulseBump( REAL ahead, REAL front )
{
    if ( front > sg_routePulseRange )
        return 0;
    REAL const life = std::pow( 1 - front / sg_routePulseRange, REAL( 1.2 ) );
    REAL const m = ahead - front;
    if ( m > sg_routePulseWidth )
        return 0;
    return std::exp( -( m * m ) / ( sg_routePulseWidth * sg_routePulseWidth ) ) * life;
}

static REAL sg_Clamp01( REAL x )
{
    return x < 0 ? 0 : ( x > 1 ? 1 : x );
}

REAL gRouteGuideLook::Fade( REAL along, REAL progress, REAL windowEnd, REAL length, bool near )
{
    REAL fade = std::min( REAL( 1 ), ( length - along ) / sg_routeEndFade );
    fade *= sg_Clamp01( ( windowEnd - along ) / sg_routeFarFade );
    if ( near )
        fade *= std::min( REAL( 1 ), ( along - progress ) / sg_routeNearFade );
    return fade < 0 ? 0 : fade;
}

// *******************************************************************************
// *
// *	gRouteGuide
// *
// *******************************************************************************

// the guide shown now (one at a time)
static gRouteGuide * sg_routeGuide = NULL;

void gRouteGuide::OnRouteGuide( unsigned short cycleID, std::vector< eCoord > const & corners )
{
    if ( corners.size() < 2 )
        return;

    // the cycle's grid if it is here already, else the one being played on
    eGrid * grid = eGrid::CurrentGrid();
    gCycle * cycle = dynamic_cast< gCycle * >( nNetObject::ObjectDangerous( cycleID ) );
    if ( cycle && cycle->Grid() )
        grid = cycle->Grid();
    if ( !grid )
        return;

    if ( sg_routeGuide )
        sg_routeGuide->Kill();

    tNEW( gRouteGuide )( grid, cycleID, corners, se_GameTime() );
}

gRouteGuide::gRouteGuide( eGrid * grid, unsigned short cycleID, std::vector< eCoord > const & corners, REAL time )
    : eReferencableGameObject( grid, corners.front(), eCoord( 0, 0 ), NULL, true ),
      path_( corners ),
      chevrons_( path_.Chevrons() ),
      cycleID_( cycleID ),
      since_( tSysTimeFloat() ),
      progress_( 0 ),
      offSince_( -1 ),
      owned_( false ),
      done_( false )
{
    lastTime = time;
    z = 0;
    sg_routeGuide = this;

    AddToList();
}

gRouteGuide::~gRouteGuide()
{
    if ( sg_routeGuide == this )
        sg_routeGuide = NULL;
}

void gRouteGuide::OnRemoveFromGame()
{
    if ( sg_routeGuide == this )
        sg_routeGuide = NULL;

    eReferencableGameObject::OnRemoveFromGame();
}

void gRouteGuide::Kill()
{
    done_ = true;
}

gCycle * gRouteGuide::Cycle() const
{
    gCycle * cycle = dynamic_cast< gCycle * >( nNetObject::ObjectDangerous( cycleID_ ) );
    if ( cycle && cycle->Grid() != grid )
        return NULL;
    return cycle;
}

// whether the cycle is alive and controlled by a player of this client
static bool sg_RouteCycleOwned( gCycle * cycle )
{
    if ( !cycle || !cycle->Alive() )
        return false;
    ePlayerNetID * player = cycle->Player();
    return player && player->Object() == cycle && player->Owner() == sn_myNetID;
}

// how far ahead the progress point may jump in one step
static REAL sg_RouteLookahead( gCycle const * cycle )
{
    return std::max( REAL( 20 ), cycle->Speed() );
}

bool gRouteGuide::Timestep( REAL currentTime )
{
    lastTime = currentTime;

    if ( done_ || currentTime > sg_routeRoundTime )
        return true;

    gCycle * cycle = Cycle();
    if ( !sg_RouteCycleOwned( cycle ) )
    {
        // gone, or no longer the player's; before it was seen, wait for it a little
        if ( owned_ || ( cycle && !cycle->Alive() ) || tSysTimeFloat() - since_ > sg_routeWaitForCycle )
            done_ = true;
        return done_;
    }
    owned_ = true;

    REAL off = 0;
    progress_ = path_.Advance( progress_, cycle->PredictPosition(), cycle->Direction(), sg_RouteLookahead( cycle ), off );

    // the end of the route reached
    if ( progress_ >= path_.Length() - .5 )
        done_ = true;

    // off the route for too long
    if ( off > sg_routeOffDistance )
    {
        if ( offSince_ < 0 )
            offSince_ = currentTime;
        else if ( currentTime - offSince_ > sg_routeOffTime )
            done_ = true;
    }
    else
        offSince_ = -1;

    return done_;
}

#ifndef DEDICATED

bool gRouteGuide::RendersAlpha() const
{
    return sr_alphaBlend;
}

// one quad across the line from a to b (on the floor), alpha and half width at each end
static void sg_RouteQuad( eCoord const & a, eCoord const & b, eCoord const & n, REAL alphaA, REAL alphaB, REAL halfA, REAL halfB )
{
    glColor4f( sg_routeR, sg_routeG, sg_routeB, alphaA );
    glVertex3f( a.x + n.x * halfA, a.y + n.y * halfA, 0 );
    glVertex3f( a.x - n.x * halfA, a.y - n.y * halfA, 0 );
    glColor4f( sg_routeR, sg_routeG, sg_routeB, alphaB );
    glVertex3f( b.x - n.x * halfB, b.y - n.y * halfB, 0 );
    glVertex3f( b.x + n.x * halfB, b.y + n.y * halfB, 0 );
}

// the soft halo beside one side of the line: alpha at the line's edge, nothing outside
static void sg_RouteHalo( eCoord const & a, eCoord const & b, eCoord const & n, REAL alphaA, REAL alphaB, REAL innerA, REAL innerB, REAL outerA, REAL outerB )
{
    glColor4f( sg_routeR, sg_routeG, sg_routeB, alphaA );
    glVertex3f( a.x + n.x * innerA, a.y + n.y * innerA, 0 );
    glColor4f( sg_routeR, sg_routeG, sg_routeB, 0 );
    glVertex3f( a.x + n.x * outerA, a.y + n.y * outerA, 0 );
    glVertex3f( b.x + n.x * outerB, b.y + n.y * outerB, 0 );
    glColor4f( sg_routeR, sg_routeG, sg_routeB, alphaB );
    glVertex3f( b.x + n.x * innerB, b.y + n.y * innerB, 0 );
}

// how much of what draws on top of the walls shows at p, with the own cycle at
// cyclePos heading along cycleDir (unit length)
static REAL sg_RouteClearOfCycle( eCoord const & p, eCoord const & cyclePos, eCoord const & cycleDir )
{
    return sg_Clamp01( ( eCoord::F( p - cyclePos, cycleDir ) - sg_routeCycleClear ) / sg_routeCycleFade );
}

// the line from me to last in pieces of at most a unit, so the fades and the pulse
// are smooth: at rest (pulse false), or only what the pulse adds to it (pulse true)
static void sg_RouteLine( gRoutePath const & path, REAL me, REAL last, REAL windowEnd, REAL front, bool pulse, eCoord const & cyclePos, eCoord const & cycleDir )
{
    static REAL const step = 1;
    REAL const length = path.Length();
    for ( int i = 0; i < path.Segments(); ++i )
    {
        REAL const start = path.SegmentStart( i ), len = path.SegmentLength( i );
        REAL const from = std::max( start, me ), to = std::min( start + len, last );
        if ( len <= 0 || to <= from )
            continue;

        eCoord const d = path.SegmentDirection( i );
        eCoord const n( -d.y, d.x );
        int const pieces = std::max( 1, int( std::ceil( ( to - from ) / step ) ) );
        for ( int k = 0; k < pieces; ++k )
        {
            REAL const s0 = from + ( to - from ) * k / pieces;
            REAL const s1 = from + ( to - from ) * ( k + 1 ) / pieces;
            REAL bump0 = 0, bump1 = 0;
            if ( pulse )
            {
                bump0 = gRouteGuideLook::PulseBump( s0 - me, front );
                bump1 = gRouteGuideLook::PulseBump( s1 - me, front );
            }
            REAL const scale0 = pulse ? ( 1 - sg_routeLineAlpha ) * bump0 : sg_routeLineAlpha;
            REAL const scale1 = pulse ? ( 1 - sg_routeLineAlpha ) * bump1 : sg_routeLineAlpha;
            REAL a0 = scale0 * gRouteGuideLook::Fade( s0, me, windowEnd, length, true );
            REAL a1 = scale1 * gRouteGuideLook::Fade( s1, me, windowEnd, length, true );
            if ( pulse )
            {
                a0 *= sg_RouteClearOfCycle( path.PointAt( s0 ), cyclePos, cycleDir );
                a1 *= sg_RouteClearOfCycle( path.PointAt( s1 ), cyclePos, cycleDir );
            }
            if ( a0 <= .005f && a1 <= .005f )
                continue;
            REAL const h0 = ( sg_routeLineWidth + sg_routePulseWiden * bump0 ) * .5f;
            REAL const h1 = ( sg_routeLineWidth + sg_routePulseWiden * bump1 ) * .5f;

            // a corner is drawn once (the quads add up): the stretch before it reaches half a
            // width past it and the one after starts half a width after it; the halos stay out
            // of the corner's square (the one before stops half a width short, the one after
            // starts a halo's width after it)
            bool const cornerBefore = i > 0 && k == 0 && s0 > me;
            bool const cornerAfter = k == pieces - 1 && s1 < last;
            REAL l0 = s0 - start, l1 = s1 - start, hl0 = l0, hl1 = l1;
            if ( cornerBefore )
            {
                l0 += h0;
                hl0 += h0 * sg_routeHaloWidth;
            }
            if ( cornerAfter )
            {
                l1 += h1;
                hl1 -= h1;
            }
            hl0 = std::max( hl0, s0 - start );
            hl1 = std::min( hl1, s1 - start );

            if ( l1 > l0 )
                sg_RouteQuad( path.Corner( i ) + d * l0, path.Corner( i ) + d * l1, n, a0, a1, h0, h1 );
            if ( hl1 > hl0 )
            {
                eCoord const q0 = path.Corner( i ) + d * hl0, q1 = path.Corner( i ) + d * hl1;
                sg_RouteHalo( q0, q1, n, a0 * sg_routeHaloAlpha, a1 * sg_routeHaloAlpha, h0, h1, h0 * sg_routeHaloWidth, h1 * sg_routeHaloWidth );
                sg_RouteHalo( q0, q1, -n, a0 * sg_routeHaloAlpha, a1 * sg_routeHaloAlpha, h0, h1, h0 * sg_routeHaloWidth, h1 * sg_routeHaloWidth );
            }
        }
    }
}

void gRouteGuide::Render( const eCamera * cam )
{
    if ( done_ )
        return;

    // only for the cycle's own player, in that player's view
    gCycle * cycle = Cycle();
    if ( !sg_RouteCycleOwned( cycle ) || !cam || cam->Player() != cycle->Player() )
        return;

    // game objects do not step during the countdown (gGame::GameLoop steps only the
    // cameras), so the cycle counts as seen here as well: the line shows from the countdown on
    owned_ = true;

    // where the cycle is now, as drawn
    REAL off = 0;
    REAL const me = path_.Advance( progress_, cycle->PredictPosition(), cycle->Direction(), sg_RouteLookahead( cycle ), off );
    REAL const length = path_.Length();
    REAL const windowEnd = gRouteGuideLook::WindowEnd( me, cycle->Speed() );
    REAL const last = std::min( windowEnd, length );
    if ( last <= me )
        return;

    REAL const front = gRouteGuideLook::PulseFront( REAL( tSysTimeFloat() - since_ ) );

    ModelMatrix();

    glDisable( GL_LIGHT0 );
    glDisable( GL_LIGHT1 );
    glDisable( GL_LIGHTING );
    glDisable( GL_CULL_FACE );
    glDisable( GL_TEXTURE_2D );
    glDepthMask( GL_FALSE );
    sr_DepthOffset( true );

    if ( !sr_alphaBlend )
    {
        // no blending: one line strip, as bright as the line is at rest
        glColor3f( sg_routeR * .6f, sg_routeG * .6f, sg_routeB );
        BeginLineStrip();
        eCoord const start = path_.PointAt( me );
        glVertex3f( start.x, start.y, 0 );
        for ( int i = 0; i < path_.Segments(); ++i )
        {
            REAL const corner = path_.SegmentStart( i + 1 );
            if ( corner <= me )
                continue;
            eCoord const p = path_.PointAt( std::min( corner, last ) );
            glVertex3f( p.x, p.y, 0 );
            if ( corner >= last )
                break;
        }
        RenderEnd();

        sr_DepthOffset( false );
        glDepthMask( GL_TRUE );
        return;
    }

#ifdef AA_GLES2
    // into the bloom mask where the quality tier has bloom (nothing is recorded without)
    sr_GLES2SetGlow( 1 );
#endif
    glBlendFunc( GL_SRC_ALPHA, GL_ONE );
    BeginQuads();

    // the line at rest, under the walls: on the grind it rides beside a trail
    eCoord const cyclePos = cycle->PredictPosition();
    eCoord cycleDir = cycle->Direction();
    REAL const cycleDirLength = cycleDir.Norm();
    if ( cycleDirLength > 0 )
        cycleDir = cycleDir * ( 1 / cycleDirLength );
    sg_RouteLine( path_, me, last, windowEnd, front, false, cyclePos, cycleDir );
    RenderEnd();

    // the pulse and the chevrons on top of everything, so the way to go shows
    // also where a trail hides the line
    glDisable( GL_DEPTH_TEST );
    BeginQuads();
    sg_RouteLine( path_, me, last, windowEnd, front, true, cyclePos, cycleDir );

    // the chevrons inside the window, faint at rest and lit as the pulse passes
    REAL const half = sg_routeChevronWidth * .5f;
    for ( size_t c = 0; c < chevrons_.size(); ++c )
    {
        gRoutePath::Chevron const & chevron = chevrons_[c];
        if ( chevron.along < me + 2 || chevron.along > last - 2 )
            continue;
        REAL const bump = gRouteGuideLook::PulseBump( chevron.along - me, front );
        REAL const a = ( sg_routeChevronAlpha + ( 1 - sg_routeChevronAlpha ) * bump ) * gRouteGuideLook::Fade( chevron.along, me, windowEnd, length, false )
                       * sg_RouteClearOfCycle( chevron.pos, cyclePos, cycleDir );
        if ( a <= .02f )
            continue;

        // two strokes from behind the centre, out to the sides, to the tip ahead
        eCoord const d = chevron.dir;
        eCoord const n( -d.y, d.x );
        eCoord const tip = chevron.pos + d * ( .45f * sg_routeChevronSize );
        eCoord const back = chevron.pos - d * ( .55f * sg_routeChevronSize );
        for ( int side = -1; side <= 1; side += 2 )
        {
            eCoord const wing = back + n * ( side * .8f * sg_routeChevronSize );
            eCoord const stroke = tip - wing;
            REAL const strokeLength = stroke.Norm();
            if ( strokeLength <= 0 )
                continue;
            eCoord const sn( -stroke.y / strokeLength, stroke.x / strokeLength );
            sg_RouteQuad( wing, tip, sn, a, a, half, half );
        }
    }

    RenderEnd();
    glEnable( GL_DEPTH_TEST );
    glBlendFunc( GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA );
#ifdef AA_GLES2
    sr_GLES2SetGlow( 0 );
#endif

    sr_DepthOffset( false );
    glDepthMask( GL_TRUE );
}

#endif // DEDICATED
