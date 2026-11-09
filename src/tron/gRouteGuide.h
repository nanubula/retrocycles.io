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

#ifndef ArmageTron_ROUTE_GUIDE_H
#define ArmageTron_ROUTE_GUIDE_H

//! The route guide: a faint gold line on the floor that shows the player the
//! path their position usually takes in a round's opening. The server sends the
//! corners (message 383, route_guide, src/engine/ePlatform.h) to clients that
//! announced "route"; this client draws the next stretch of it ahead of the
//! own cycle, with small chevrons and a pulse that runs ahead, until the cycle
//! reaches the end, leaves the path, dies, or the round is 30 s old.

#include "eCoord.h"
#include "eGameObject.h"

#include <vector>

class gCycle;

//! a route as a polyline, measured along its length (pure geometry)
class gRoutePath
{
public:
    explicit gRoutePath( std::vector< eCoord > const & corners );

    REAL Length() const { return starts_.empty() ? 0 : starts_.back(); }
    int Segments() const { return static_cast< int >( corners_.size() ) - 1; }
    eCoord const & Corner( int i ) const { return corners_[i]; }
    REAL SegmentStart( int i ) const { return starts_[i]; }   //!< length along the route to corner i
    REAL SegmentLength( int i ) const { return starts_[i+1] - starts_[i]; }
    eCoord SegmentDirection( int i ) const;                    //!< unit direction of segment i (0 if it has no length)

    eCoord PointAt( REAL along ) const;                        //!< the point at a length along the route (clamped)

    //! where a cycle at pos heading dir is along the route, never behind progress: the
    //! nearest point among the segments from progress to progress + lookahead, where a
    //! segment that runs against dir counts as further away (routes double back on
    //! themselves a few tenths apart). off: pos's distance from that point.
    REAL Advance( REAL progress, eCoord const & pos, eCoord const & dir, REAL lookahead, REAL & off ) const;

    //! a chevron: where along the route, where on the floor, the way it points
    struct Chevron
    {
        REAL along;
        eCoord pos;
        eCoord dir;
    };

    //! the chevrons of the whole route: packed groups of 2-4 on each straight stretch
    std::vector< Chevron > Chevrons() const;

private:
    std::vector< eCoord > corners_;
    std::vector< REAL > starts_; // length along the route to each corner
};

//! the look of the guide, in map units and seconds
namespace gRouteGuideLook
{
//! the far end of the visible line: the next 3 s at speed, at least 45 units
REAL WindowEnd( REAL progress, REAL speed );

//! how far ahead of the cycle the pulse is, t seconds after the guide appeared
REAL PulseFront( REAL t );

//! how bright the pulse is at a point ahead units ahead of the cycle (0..1)
REAL PulseBump( REAL ahead, REAL front );

//! the fades of the line at along: in over 3 units ahead of the cycle (near), out
//! over the last 18 units of the window and the last 25 of the route
REAL Fade( REAL along, REAL progress, REAL windowEnd, REAL length, bool near );
}

//! the guide on the floor: client side only, removed with the grid like gExplosion
class gRouteGuide: public eReferencableGameObject
{
public:
    //! the route_guide handler (ePlatform::SetRouteGuideCallback): replaces any guide shown
    static void OnRouteGuide( unsigned short cycleID, std::vector< eCoord > const & corners );

    gRouteGuide( eGrid * grid, unsigned short cycleID, std::vector< eCoord > const & corners, REAL time );
    virtual ~gRouteGuide();

    virtual bool Timestep( REAL currentTime );
    virtual void Kill();

#ifndef DEDICATED
    virtual void Render( const eCamera * cam );
    virtual bool RendersAlpha() const;
#endif

protected:
    virtual void OnRemoveFromGame();

private:
    gCycle * Cycle() const; // the cycle with the message's id, looked up every time

    gRoutePath path_;
    std::vector< gRoutePath::Chevron > chevrons_;
    unsigned short cycleID_;
    double since_;      // system time the guide appeared (the pulse runs on it)
    REAL progress_;     // along the route, forward only
    REAL offSince_;     // game time the cycle went off the route, -1 while on it
    bool owned_;        // the cycle was seen alive and controlled by a player here
    bool done_;
};

#endif
